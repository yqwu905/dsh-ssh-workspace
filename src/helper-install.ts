/** Install the locked runtime through SSH stdin; the remote never contacts a package/LLM endpoint. */
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { shellQuote as q, sshCommand } from './commands.js'
import { HELPER_PATH, isTarget, prepareBundle, type HelperBundle, type Progress, type Target } from './helper-bundle.js'

export interface Deployment { helper: string; helperHash: string; launch: { kind: 'node-script'; node: string } }
export interface RemotePlatform { home: string; target: Target }
export async function detectPlatform(host: string): Promise<RemotePlatform> {
  const output = await sshCommand(host, `set -eu
cd "$HOME"
printf '\\nDSH_PLATFORM_BEGIN\\n'
pwd -P
uname -s
uname -m
printf 'DSH_PLATFORM_END\\n'`)
  const match = /(?:^|\n)DSH_PLATFORM_BEGIN\n([^\n]+)\n([^\n]+)\n([^\n]+)\nDSH_PLATFORM_END(?:\n|$)/u.exec(output)
  if (!match) throw new Error('Cannot read the remote platform and home directory')
  const home = match[1]!, os = match[2]!, machine = match[3]!
  const platform = os === 'Linux' ? 'linux' : os === 'Darwin' ? 'darwin' : os
  const arch = ['x86_64', 'amd64'].includes(machine) ? 'x64' : ['aarch64', 'arm64'].includes(machine) ? 'arm64' : machine
  const target = `${platform}-${arch}`
  if (!isTarget(target)) throw new Error(`Automatic helper installation supports Linux/macOS x64/arm64; detected ${target}`)
  if (!home.startsWith('/') || /[\0\r\n]/u.test(home) || home === '/') throw new Error('Remote account needs a normal absolute home directory')
  return { home: posix.normalize(home), target }
}

const hashFunction = `hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else echo 'sha256sum or shasum is required on the SSH server' >&2; return 1; fi
}`

/** Shell verifies the executable/verifier before executing either, then verifies the entire closure. */
export function verificationScript(directory: string, bundle: HelperBundle): string {
  return `${hashFunction}
[ ! -L ${q(directory)} ]
[ "$(hash_file ${q(posix.join(directory, 'node/bin/node'))})" = ${q(bundle.nodeHash)} ]
[ "$(hash_file ${q(posix.join(directory, 'verify.mjs'))})" = ${q(bundle.verifierHash)} ]
[ "$(hash_file ${q(posix.join(directory, 'payload-manifest.json'))})" = ${q(bundle.manifestHash)} ]
${q(posix.join(directory, 'node/bin/node'))} ${q(posix.join(directory, 'verify.mjs'))} ${q(bundle.manifestHash)}`
}

export function installationScript(directory: string, bundle: HelperBundle): string {
  const parent = posix.dirname(directory), staging = `${directory}.staging`
  return `set -eu
umask 077
base=${q(parent)}
stage=${q(staging)}
dest=${q(directory)}
mkdir -p "$base"
[ "$(cd "$base" && pwd -P)" = "$base" ] || { echo 'Runtime parent must not contain symlinks' >&2; exit 1; }
[ ! -e "$dest" ] && [ ! -L "$dest" ]
mkdir "$stage"
cleanup() { chmod -R u+w "$stage" 2>/dev/null || true; rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
cat > "$stage/archive.tar.gz"
${hashFunction}
[ "$(hash_file "$stage/archive.tar.gz")" = ${q(bundle.archiveHash)} ] || { echo 'Uploaded archive checksum mismatch' >&2; exit 1; }
mkdir "$stage/runtime"
tar -xzpf "$stage/archive.tar.gz" --no-same-owner -C "$stage/runtime"
chmod -R a-w "$stage/runtime"
${verificationScript(posix.join(staging, 'runtime'), bundle)}
chmod u+w "$stage/runtime"
mv "$stage/runtime" "$dest"
chmod a-w "$dest"
printf 'DSH_HELPER_INSTALLED\\n'`
}

export async function deployBundle(host: string, home: string, bundle: HelperBundle, timeoutMs: number,
  progress: Progress, previous?: string): Promise<Deployment> {
  const parent = posix.join(home, '.local/share/dsh-ssh-workspaces/runtimes')
  const prefix = `${parent}/${bundle.key}-`
  // Only reuse our immutable version directory. Never overwrite a user path or an in-use runtime.
  if (previous?.endsWith('/' + HELPER_PATH)) {
    const directory = previous.slice(0, -HELPER_PATH.length - 1)
    if (directory.startsWith(prefix) && /^[a-f0-9-]{36}$/u.test(directory.slice(prefix.length))) {
      progress('verifying')
      try {
        const check = await sshCommand(host, `set -eu\n${verificationScript(directory, bundle)}`, { timeoutMs })
        if (check.trim().endsWith('DSH_HELPER_READY')) return { helper: previous, helperHash: bundle.helperHash, launch: { kind: 'node-script', node: posix.join(directory, 'node/bin/node') } }
      } catch { /* Missing/corrupt deployment: install a fresh version, retain the old one. */ }
    }
  }
  const directory = prefix + randomUUID()
  progress('uploading')
  const output = await sshCommand(host, installationScript(directory, bundle), { inputFile: bundle.archive, timeoutMs })
  if (!output.trim().endsWith('DSH_HELPER_INSTALLED')) throw new Error('Remote helper installation did not complete')
  progress('verifying')
  // Verify relocation as well: some native dependencies locate sidecar resources relative to the entry.
  const check = await sshCommand(host, `set -eu\n${verificationScript(directory, bundle)}`, { timeoutMs })
  if (!check.trim().endsWith('DSH_HELPER_READY')) throw new Error('Remote helper verification did not complete')
  return { helper: posix.join(directory, HELPER_PATH), helperHash: bundle.helperHash, launch: { kind: 'node-script', node: posix.join(directory, 'node/bin/node') } }
}

export async function ensureHelper(host: string, stateDir: string, timeoutMs: number, progress: Progress, previous?: string): Promise<Deployment> {
  progress('detecting')
  const platform = await detectPlatform(host)
  progress('preparing')
  const bundle = await prepareBundle(platform.target, stateDir, timeoutMs)
  return deployBundle(host, platform.home, bundle, timeoutMs, progress, previous)
}
