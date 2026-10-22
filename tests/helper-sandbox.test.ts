import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { adaptSandboxSource, installBundledSandbox, validateStaticElf } from '../src/helper-sandbox.js'
import { command } from '../src/commands.js'

const vendor = resolve('runtime/vendor/bubblewrap')
const original = () => readFile('node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js', 'utf8')

test('both bundled ELF files are pinned, static and target-specific', async () => {
  const manifest = JSON.parse(await readFile(join(vendor, 'manifest.json'), 'utf8'))
  for (const arch of ['x64', 'arm64'] as const) {
    const data = await readFile(join(vendor, `linux-${arch}/bwrap`))
    assert.equal(createHash('sha256').update(data).digest('hex'), manifest.binaries[`linux-${arch}`].sha256)
    validateStaticElf(data, arch)
    assert.throws(() => validateStaticElf(data, arch === 'x64' ? 'arm64' : 'x64'), /architecture/u)
    const dynamic = Buffer.from(data)
    dynamic.writeUInt32LE(3, Number(dynamic.readBigUInt64LE(32)))
    assert.throws(() => validateStaticElf(dynamic, arch), /system ELF interpreter/u)
  }
})

test('pinned provider adapter rejects source drift; macOS receives no Linux runner', async () => {
  const source = await original()
  assert.throws(() => adaptSandboxSource(source + '\n'), /Unsupported sandbox-local source/u)
  const adapted = adaptSandboxSource(source)
  assert.match(adapted, /case "bwrap": return \[__dshSshSelectedBwrap/u)
  // A nonexistent directory is intentional: a macOS preparation must not read/write Linux assets.
  await installBundledSandbox('/nonexistent/dsh-macos-fixture', 'darwin-arm64')
})

test('native bundled runner starts without system libraries', { skip: process.platform !== 'linux' }, async () => {
  assert.equal((await command(join(vendor, `linux-${process.arch}/bwrap`), ['--version'], { env: { PATH: '/nonexistent' } })).trim(), 'bubblewrap 0.13.1')
})

test('actual adapted provider probes and pins bundled/system runners, preserves Landlock and fails closed', async t => {
  const root = await mkdtemp(join(process.cwd(), '.sandbox-fixture-'))
  try {
    const module = join(root, 'node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js')
    await mkdir(join(module, '..'), { recursive: true })
    await writeFile(join(module, '../../package.json'), '{"type":"module"}')
    await writeFile(module, await original())
    await installBundledSandbox(root, 'linux-x64')
    await mkdir(join(root, 'system'))
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'system/bwrap'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    for (const selection of ['bundled', 'system', 'landlock', 'none']) {
      await t.test(selection, async () => {
        const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
const calls = [];
process.env.PATH = ${JSON.stringify(join(root, 'system'))};
childProcess.spawnSync = (file, argv) => {
  calls.push({file, argv});
  const role = file.endsWith('/tools/bin/bwrap') ? 'bundled' : file.endsWith('/system/bwrap') ? 'system' : file.endsWith('/landlock-run') ? 'landlock' : 'unexpected';
  if (role === 'unexpected') throw new Error('Unexpected probe: ' + file);
  return {status: role === ${JSON.stringify(selection)} ? 0 : 1, stdout: 'partially enforced'};
};
syncBuiltinESMExports();
const { LocalSandboxProvider } = await import(${JSON.stringify(pathToFileURL(module).href)});
const ctx = new Context();
await ctx.plugin(LocalSandboxProvider);
let result;
try { result = await ctx.sandbox.confine(['/bin/true'], {mode:'workspace-write', workspaceRoot:${JSON.stringify(join(root, 'project'))}}); }
catch (error) { result = {code:error.code}; }
await ctx.fiber.dispose();
console.log(JSON.stringify({result,calls}));`
        const { result, calls } = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', script]))
        assert.equal(calls[0].file, join(root, 'tools/bin/bwrap'))
        assert.ok(calls.every((call: any) => !call.argv.includes(join(root, 'project'))), 'probes stay read-only')
        if (selection === 'none') assert.equal(result.code, 'SANDBOX_UNAVAILABLE')
        else if (selection === 'landlock') { assert.match(result.argv[0], /landlock-run$/u); assert.equal(result.enforcement, 'partial') }
        else {
          assert.equal(result.argv[0], join(root, selection === 'bundled' ? 'tools/bin/bwrap' : 'system/bwrap'))
          assert.ok(result.argv.includes(join(root, 'project')))
          assert.equal(result.enforcement, 'full')
        }
        assert.equal(calls.length, selection === 'bundled' ? 1 : selection === 'system' ? 2 : 3)
      })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
