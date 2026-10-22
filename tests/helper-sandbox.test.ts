import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { adaptLandlockSource, adaptSandboxSource, installBundledSandbox, validateStaticElf } from '../src/helper-sandbox.js'
import { command } from '../src/commands.js'

const vendor = resolve('runtime/vendor/bubblewrap')
const original = () => readFile('node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js', 'utf8')
const originalLandlock = () => readFile('node_modules/@deepseek-ai/node-addon-system/lib/index.js', 'utf8')

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
  assert.throws(() => adaptLandlockSource(''), /Unsupported Landlock source/u)
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
    const landlock = join(root, 'node_modules/@deepseek-ai/node-addon-system')
    await mkdir(join(landlock, 'lib'), { recursive: true })
    await writeFile(join(landlock, 'package.json'), await readFile('node_modules/@deepseek-ai/node-addon-system/package.json'))
    await writeFile(join(landlock, 'lib/index.js'), await originalLandlock())
    await installBundledSandbox(root, 'linux-x64')
    await mkdir(join(root, 'system'))
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'system/bwrap'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
    for (const selection of ['bundled', 'system', 'landlock', 'landlock-full', 'none', 'no-system', 'spawn-errors', 'timeout', 'long-stderr']) {
      await t.test(selection, async () => {
        const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { Context } from '@deepseek-ai/cordis';
const calls = [];
const selection = ${JSON.stringify(selection)};
process.env.PATH = selection === 'no-system' ? '/nonexistent-dsh-system-path' : ${JSON.stringify(join(root, 'system'))};
childProcess.spawnSync = (file, argv, options) => {
  calls.push({file, argv});
  if (options.stdio[2] !== 'pipe' || options.maxBuffer !== 16384 || options.timeout !== 5000) throw new Error('Probe output/time limits missing');
  const role = file.endsWith('/tools/bin/bwrap') ? 'bundled' : file.endsWith('/system/bwrap') ? 'system' : file.endsWith('/landlock-run') ? 'landlock' : 'unexpected';
  if (role === 'unexpected') throw new Error('Unexpected probe: ' + file);
  if (selection === 'spawn-errors') return {status:null, error:{code:role === 'landlock' ? 'ENOENT' : 'EACCES', message:'spawn failed'}};
  if (selection === 'timeout') return {status:null, signal:'SIGTERM', error:{code:'ETIMEDOUT', message:'probe timed out'}};
  if (selection === 'long-stderr') return {status:1, stderr:'X'.repeat(40000) + 'END_OF_HUGE_STDERR'};
  return {status:role === selection || role === 'landlock' && selection === 'landlock-full' ? 0 : 1,
    stdout:selection === 'landlock-full' ? 'fully enforced' : 'partially enforced',
    stderr: role === 'landlock' ? 'landlock-run: sandbox fully unenforced' : '\\u001b[31mbwrap: Creating new namespace failed: Operation not permitted\\u001b[0m\\n'};
};
syncBuiltinESMExports();
const { LocalSandboxProvider } = await import(${JSON.stringify(pathToFileURL(module).href)});
const ctx = new Context();
await ctx.plugin(LocalSandboxProvider);
let result;
try { result = await ctx.sandbox.confine(['/bin/true'], {mode:'workspace-write', workspaceRoot:${JSON.stringify(join(root, 'project'))}}); }
catch (error) { result = {code:error.code, message:error.message}; }
// Cached failures retain their detail without spawning another round of probes.
if (result.code) {
  try { await ctx.sandbox.confine(['/bin/true'], {mode:'workspace-write', workspaceRoot:${JSON.stringify(join(root, 'project'))}}); }
  catch (error) { if (error.message !== result.message) throw new Error('Cached diagnostic changed'); }
}
await ctx.fiber.dispose();
console.log(JSON.stringify({result,calls}));`
        const { result, calls } = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', script]))
        assert.equal(calls[0].file, join(root, 'tools/bin/bwrap'))
        assert.ok(calls.every((call: any) => !call.argv.includes(join(root, 'project'))), 'probes stay read-only')
        if (selection === 'landlock' || selection === 'landlock-full') {
          assert.match(result.argv[0], /landlock-run$/u)
          assert.equal(result.enforcement, selection === 'landlock' ? 'partial' : 'full')
        } else if (selection === 'bundled' || selection === 'system') {
          assert.equal(result.argv[0], join(root, selection === 'bundled' ? 'tools/bin/bwrap' : 'system/bwrap'))
          assert.ok(result.argv.includes(join(root, 'project')))
          assert.equal(result.enforcement, 'full')
        } else {
          assert.equal(result.code, 'SANDBOX_UNAVAILABLE')
          assert.match(result.message, /Managed helper sandbox probes: .*kernel=.*euid=/u)
          assert.match(result.message, /Bundled bubblewrap.*exit=/u)
          assert.match(result.message, /Landlock.*exit=/u)
          assert.ok(result.message.length < 10000, 'diagnostics have a bounded size')
          assert.doesNotMatch(result.message, /\u001b|END_OF_HUGE_STDERR/u)
          if (selection === 'none') {
            assert.match(result.message, /System bubblewrap.*exit=1/u)
            assert.match(result.message, /bwrap: Creating new namespace failed: Operation not permitted/u)
            assert.match(result.message, /landlock-run: sandbox fully unenforced/u)
          }
          if (selection === 'no-system') assert.match(result.message, /no executable bwrap found on the helper PATH/u)
          if (selection === 'spawn-errors') { assert.match(result.message, /EACCES/u); assert.match(result.message, /ENOENT/u) }
          if (selection === 'timeout') { assert.match(result.message, /ETIMEDOUT/u); assert.match(result.message, /signal=SIGTERM/u) }
          if (selection === 'long-stderr') assert.match(result.message, /\[truncated\]/u)
        }
        assert.equal(calls.length, selection === 'bundled' ? 1 : selection === 'system' || selection === 'no-system' ? 2 : 3)
      })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
