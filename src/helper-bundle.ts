/** Prepare a locked, target-specific helper closure on the Host. No remote package manager. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { command } from './commands.js'
import { installBundledSandbox } from './helper-sandbox.js'

export const DSH_VERSION = '0.2.1-rc.2'
export const NODE_VERSION = '24.19.0'
// From https://nodejs.org/dist/v24.19.0/SHASUMS256.txt, retrieved 2026-10-22.
export const NODE_SHA256 = {
  'linux-x64': 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
  'linux-arm64': 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
  'darwin-x64': 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
  'darwin-arm64': '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
} as const
export type Target = keyof typeof NODE_SHA256
export type SetupPhase = 'detecting' | 'preparing' | 'uploading' | 'verifying'
export type Progress = (phase: SetupPhase) => void
export interface HelperBundle {
  key: string; archive: string; archiveHash: string; helperHash: string; nodeHash: string; verifierHash: string; manifestHash: string
}
export const HELPER_PATH = 'node_modules/@deepseek-ai/dsh-ssh/lib/helper.js'
const runtimeDirectory = fileURLToPath(new URL('../runtime/', import.meta.url))
const pending = new Map<string, Promise<HelperBundle>>()

export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const part of createReadStream(path)) hash.update(part)
  return hash.digest('hex')
}
export function isTarget(value: string): value is Target { return Object.hasOwn(NODE_SHA256, value) }

export async function bundleKey(target: Target): Promise<string> {
  const hash = createHash('sha256').update(`managed-runtime-v2:${target}:${NODE_SHA256[target]}`)
  for (const name of ['package.json', 'package-lock.json', 'verify.mjs', ...['manifest.json', 'NOTICE.md', 'LICENSE-bubblewrap', 'LICENSE-musl', 'LICENSE-libcap', 'LICENSE-zig'].map(name => `vendor/bubblewrap/${name}`)]) hash.update(await readFile(join(runtimeDirectory, name)))
  return `${DSH_VERSION}-${target}-${hash.digest('hex').slice(0, 20)}`
}

export async function prepareBundle(target: Target, stateDir: string, timeoutMs: number): Promise<HelperBundle> {
  const key = await bundleKey(target), cache = join(stateDir, 'helper-cache', key)
  const active = pending.get(cache)
  if (active) return active
  const build = prepare(target, key, cache, timeoutMs)
  pending.set(cache, build)
  try { return await build } finally { pending.delete(cache) }
}

async function prepare(target: Target, key: string, cache: string, timeoutMs: number): Promise<HelperBundle> {
  try {
    const saved = JSON.parse(await readFile(join(cache, 'bundle.json'), 'utf8')) as HelperBundle
    const archive = join(cache, 'runtime.tar.gz')
    if (saved.key === key && /^[a-f0-9]{64}$/u.test(saved.archiveHash) && await sha256(archive) === saved.archiveHash) return { ...saved, archive }
  } catch { /* Missing/incomplete cache: build into a new private staging directory. */ }
  const parent = join(cache, '..')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(parent, '.prepare-'))
  try {
    const payload = join(staging, 'payload')
    await mkdir(payload, { mode: 0o700 })
    for (const name of ['package.json', 'package-lock.json', 'verify.mjs']) await copyFile(join(runtimeDirectory, name), join(payload, name))
    const [platform, arch] = target.split('-') as ['linux' | 'darwin', 'x64' | 'arm64']
    const version = (await command('npm', ['--version'])).trim()
    if (Number(version.split('.')[0]) < 10) throw new Error('Automatic helper preparation requires npm >= 10 on the Host')
    await command('npm', ['ci', '--ignore-scripts', '--omit=dev', '--include=optional', '--no-audit', '--no-fund',
      '--bin-links=false', `--os=${platform}`, `--cpu=${arch}`, ...(platform === 'linux' ? ['--libc=glibc'] : [])],
    { cwd: payload, timeoutMs })
    // npm lifecycle scripts never run. Restore only the documented spawn-helper executable bit.
    const pty = join(payload, 'node_modules/node-pty/prebuilds', target)
    await lstat(join(pty, 'pty.node'))
    if (platform === 'darwin') await chmod(join(pty, 'spawn-helper'), 0o755)
    await lstat(join(payload, `node_modules/@deepseek-ai/node-addon-system-${target}/bin`, platform === 'linux' ? 'glibc/system.node' : 'system.node'))
    await lstat(join(payload, `node_modules/@koromix/koffi-${target}`))
    await installBundledSandbox(payload, target)
    const nodeName = `node-v${NODE_VERSION}-${target}`
    const archive = join(parent, `${nodeName}.tar.gz`)
    if (await sha256(archive).catch(() => '') !== NODE_SHA256[target]) {
      const download = join(staging, 'node.tar.gz')
      await command('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https',
        '--connect-timeout', '20', '--max-time', String(Math.ceil(timeoutMs / 1000)), '--retry', '2',
        '--output', download, `https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.tar.gz`], { timeoutMs })
      if (await sha256(download) !== NODE_SHA256[target]) throw new Error('Official Node archive checksum mismatch')
      await rename(download, archive)
    }
    await mkdir(join(payload, 'node'))
    await command('tar', ['-xzf', archive, '--no-same-owner', '-C', join(payload, 'node'), '--strip-components=1', `${nodeName}/bin/node`, `${nodeName}/LICENSE`], { timeoutMs })
    await chmod(join(payload, 'node/bin/node'), 0o755)
    const files: Array<{ path: string; sha256: string; mode: number }> = []
    async function walk(directory: string, prefix = ''): Promise<void> {
      for (const name of (await readdir(directory)).sort()) {
        const path = join(directory, name), info = await lstat(path)
        if (info.isSymbolicLink()) throw new Error(`Unexpected link in helper closure: ${prefix}${name}`)
        if (info.isDirectory()) await walk(path, prefix + name + '/')
        else if (info.isFile()) files.push({ path: prefix + name, sha256: await sha256(path), mode: info.mode & 0o555 })
        else throw new Error('Unexpected special file in helper closure')
      }
    }
    await walk(payload)
    await writeFile(join(payload, 'payload-manifest.json'), JSON.stringify({ format: 1, platform, arch, nodeVersion: NODE_VERSION, files }))
    const result: HelperBundle = { key, archive: join(cache, 'runtime.tar.gz'), archiveHash: '',
      helperHash: await sha256(join(payload, HELPER_PATH)), nodeHash: await sha256(join(payload, 'node/bin/node')),
      verifierHash: await sha256(join(payload, 'verify.mjs')), manifestHash: await sha256(join(payload, 'payload-manifest.json')) }
    // Explicit files avoid archiving directory metadata while lazy filesystems update it.
    const list = join(staging, 'files.list')
    await writeFile(list, [...files.map(file => file.path), 'payload-manifest.json'].join('\0') + '\0')
    await command('tar', ['-czf', join(staging, 'runtime.tar.gz'), '-C', payload, '--no-recursion', '--null', '-T', list], { timeoutMs })
    result.archiveHash = await sha256(join(staging, 'runtime.tar.gz'))
    await writeFile(join(staging, 'bundle.json'), JSON.stringify(result), { mode: 0o600 })
    await rm(payload, { recursive: true, force: true })
    await rm(list)
    // A completed cache is immutable. Corrupt caches are retained for diagnosis, not trusted.
    try { await rename(cache, `${cache}.old-${Date.now()}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rename(staging, cache)
    return result
  } finally { await rm(staging, { recursive: true, force: true }) }
}
