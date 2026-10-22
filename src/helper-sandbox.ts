/** Supply a portable, pinned Linux runner without changing the official sandbox policy. */
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const vendor = fileURLToPath(new URL('../runtime/vendor/bubblewrap/', import.meta.url))
export const SANDBOX_LOCAL_SHA256 = 'be6e1107871cf8d94c040090b13c405bc833822e2f51ed5280e93eececf762be'
export const LANDLOCK_JS_SHA256 = 'a0f04e2990b6fff091d6776c41e56dac8c630a37b944632e743fa8f2ee9c4813'
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Reject wrong-architecture or dynamically linked artifacts before uploading them. */
export function validateStaticElf(bytes: Buffer, arch: 'x64' | 'arm64'): void {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString('hex') !== '7f454c46'
    || bytes[4] !== 2 || bytes[5] !== 1 || ![2, 3].includes(bytes.readUInt16LE(16))
    || bytes.readUInt16LE(18) !== (arch === 'x64' ? 62 : 183)) throw new Error('Bundled bubblewrap ELF architecture mismatch')
  const offset = Number(bytes.readBigUInt64LE(32)), count = bytes.readUInt16LE(56), size = bytes.readUInt16LE(54)
  if (!Number.isSafeInteger(offset) || count === 0 || size !== 56 || offset + count * size > bytes.length) throw new Error('Invalid bubblewrap ELF program headers')
  for (let index = 0; index < count; index++) {
    const header = offset + index * size, type = bytes.readUInt32LE(header)
    if (type === 3) throw new Error('Bundled bubblewrap must not require a system ELF interpreter')
    if (type !== 2) continue
    const start = Number(bytes.readBigUInt64LE(header + 8)), length = Number(bytes.readBigUInt64LE(header + 32))
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start + length > bytes.length || length % 16) throw new Error('Invalid bubblewrap ELF dynamic section')
    for (let position = start; position < start + length; position += 16) {
      if (bytes.readBigInt64LE(position) === 1n) throw new Error('Bundled bubblewrap must not require shared libraries')
    }
  }
}

/**
 * Narrow adapter for the pinned published provider. Both probing and execution
 * use the same selected absolute path. Its profiles, enforcement facts and
 * Landlock fallback remain upstream-owned; no runnerCommand override is used.
 */
export function adaptSandboxSource(source: string): string {
  if (digest(Buffer.from(source)) !== SANDBOX_LOCAL_SHA256) throw new Error('Unsupported sandbox-local source; update and review the pinned adapter before upgrading DSH')
  const start = source.indexOf('function defaultProbeBwrap(timeoutMs) {')
  const end = source.indexOf('\n}', start) + 2
  const probe = source.slice(start, end)
  const invocation = 'case "bwrap": return ["bwrap", ...bwrapProfileArgs(policy)];'
  if (start < 0 || end <= start || !probe.includes('return spawnSync("bwrap", [') || !source.includes(invocation)) throw new Error('Unexpected sandbox-local runner layout')
  const body = probe.replace('return spawnSync("bwrap", [', 'const result = spawnSync(candidate, [')
    .replace('stdio: "ignore"', 'stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", maxBuffer: 16384')
    .replace('}).status === 0;', '});').slice('function defaultProbeBwrap(timeoutMs) {'.length, -1)
  const replacement = `function defaultProbeBwrap(timeoutMs, record) {
  const system = (process.env.PATH ?? '').split(':').filter(part => part.startsWith('/')).map(part => __dshSshJoin(part, 'bwrap')).find(path => {
    try { __dshSshAccess(path, 1); return __dshSshStat(path).isFile(); } catch { return false; }
  });
  if (!system) record('System bubblewrap: no executable bwrap found on the helper PATH.');
  for (const candidate of [...new Set([__dshSshBundledBwrap, system].filter(Boolean))]) {
${body}
    if (result.status === 0) { __dshSshSelectedBwrap = candidate; return true; }
    record(__dshSshProbeDetail(candidate === __dshSshBundledBwrap ? 'Bundled bubblewrap' : 'System bubblewrap', candidate, result));
  }
  return false;
}`
  return `import { fileURLToPath as __dshSshFilePath } from 'node:url';
import { join as __dshSshJoin } from 'node:path';
import { accessSync as __dshSshAccess, statSync as __dshSshStat } from 'node:fs';
import { release as __dshSshKernel } from 'node:os';
import { stripVTControlCharacters as __dshSshStripVT } from 'node:util';
const __dshSshBundledBwrap = __dshSshFilePath(new URL('../../../../tools/bin/bwrap', import.meta.url));
let __dshSshSelectedBwrap = __dshSshBundledBwrap;
function __dshSshClean(value, limit = 2048) {
  const text = __dshSshStripVT(String(value ?? '')).replace(/[\\x00-\\x1f\\x7f-\\x9f]/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + ' [truncated]' : text;
}
function __dshSshProbeDetail(label, path, result) {
  const info = ['exit=' + (result.status ?? 'none')];
  if (result.signal) info.push('signal=' + __dshSshClean(result.signal, 64));
  if (result.error) info.push('error=' + __dshSshClean(result.error.code, 64) + ' ' + __dshSshClean(result.error.message, 512));
  info.push('stderr=' + (__dshSshClean(result.stderr) || '(empty)'));
  return label + ' (' + __dshSshClean(path, 512) + '): ' + info.join('; ');
}
function __dshSshProbeReport(details) {
  if (details.length === 0) return undefined;
  return 'Managed helper sandbox probes: ' + process.platform + '-' + process.arch + ', kernel=' + __dshSshClean(__dshSshKernel(), 256)
    + ', euid=' + (process.geteuid?.() ?? 'unknown') + '\\n' + details.join('\\n');
}
` + source.replace(probe, replacement)
    .replace(invocation, 'case "bwrap": return [__dshSshSelectedBwrap, ...bwrapProfileArgs(policy)];')
    .replace('\n\tselectedRunner;', '\n\tselectedRunner;\n\t__dshSshProbeDiagnostics = [];')
    .replace('defaultProbeBwrap(this.probeTimeoutMs)', 'defaultProbeBwrap(this.probeTimeoutMs, (detail) => this.__dshSshProbeDiagnostics.push(detail))')
    .replace('probe(launcher, { timeoutMs: this.probeTimeoutMs })', 'probe(launcher, { timeoutMs: this.probeTimeoutMs, onProbeResult: (result) => { if (result.status !== 0) this.__dshSshProbeDiagnostics.push(__dshSshProbeDetail("Landlock", launcher, result)); } })')
    .replace('throw new SandboxUnavailableError(mode);', 'throw new SandboxUnavailableError(mode, __dshSshProbeReport(this.__dshSshProbeDiagnostics));')
}

/** Preserve the upstream probe verdict/parser; expose the same spawn's failure facts. */
export function adaptLandlockSource(source: string): string {
  if (digest(Buffer.from(source)) !== LANDLOCK_JS_SHA256) throw new Error('Unsupported Landlock source; update and review the pinned adapter before upgrading DSH')
  return source.replace("stdio: ['ignore', 'pipe', 'ignore'],", "stdio: ['ignore', 'pipe', 'pipe'],\n        maxBuffer: 16384,")
    .replace('    if (result.status !== 0)', '    options.onProbeResult?.(result);\n    if (result.status !== 0)')
}

export async function installBundledSandbox(payload: string, target: string): Promise<void> {
  if (!target.startsWith('linux-')) return
  if (target !== 'linux-x64' && target !== 'linux-arm64') throw new Error('Unsupported bundled bubblewrap target')
  const manifest = JSON.parse(await readFile(join(vendor, 'manifest.json'), 'utf8'))
  const expected = manifest.binaries[target] as { sha256: string; bytes: number }
  const binary = join(vendor, target, 'bwrap'), bytes = await readFile(binary)
  if (!(await lstat(binary)).isFile() || bytes.length !== expected.bytes || digest(bytes) !== expected.sha256) throw new Error('Bundled bubblewrap checksum mismatch')
  validateStaticElf(bytes, target === 'linux-x64' ? 'x64' : 'arm64')
  await mkdir(join(payload, 'tools/bin'), { recursive: true })
  await copyFile(binary, join(payload, 'tools/bin/bwrap'))
  await chmod(join(payload, 'tools/bin/bwrap'), 0o755)
  await writeFile(join(payload, 'tools/bubblewrap.json'), JSON.stringify({ version: manifest.version, target, sha256: expected.sha256 }))
  for (const name of ['NOTICE.md', 'LICENSE-bubblewrap', 'LICENSE-musl', 'LICENSE-libcap', 'LICENSE-zig']) await copyFile(join(vendor, name), join(payload, 'tools', name))
  const provider = join(payload, 'node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js')
  const landlock = join(payload, 'node_modules/@deepseek-ai/node-addon-system/lib/index.js')
  await writeFile(landlock, adaptLandlockSource(await readFile(landlock, 'utf8')))
  await writeFile(provider, adaptSandboxSource(await readFile(provider, 'utf8')))
}
