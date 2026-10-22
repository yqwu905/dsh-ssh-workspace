#!/usr/bin/env node
/** Install a verified official helper archive over SSH without remote npm/network access. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, posix, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const run = promisify(execFile);
const SSH_OPTIONS = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3'];
const SUPPORTED_VERSION = '0.2.1-rc.2';
const HELP = `Usage:
  node scripts/deploy-helper.mjs --host SSH_ALIAS --archive /path/helper.tar.gz \\
    --sha256 EXPECTED_ARCHIVE_SHA256 --remote-dir /home/user/.local/lib/dsh-helper/0.2.1-rc.2

Requires local Python 3 (archive validation) and OpenSSH. Remote requires POSIX sh,
tar, sha256sum or shasum, and a matching Linux/macOS architecture. No remote Node,
npm or Internet connection is required. The installation directory must not exist.
Obtain an official helper archive and its checksum from the same trusted release.
All payload files, archive paths, permissions and manifest checksums are validated
before any SSH operation. Your existing SSH alias, key and known_hosts are reused.
The script prints helper/launch/helperHash fields to paste into the Web form.
`;

/** POSIX shell quoting for an entire literal argument. */
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

/** Parse the small CLI; never accept raw SSH options or remote shell text. */
export function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const values = {};
  const allowed = new Set(['--host', '--archive', '--sha256', '--remote-dir']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!allowed.has(key) || values[key] !== undefined || !argv[i + 1]) throw new Error(`Invalid or duplicate argument: ${key}`);
    values[key] = argv[i + 1];
  }
  for (const key of allowed) if (!values[key]) throw new Error(`Missing ${key}`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(values['--host'])) throw new Error('host must be an existing OpenSSH alias');
  if (!/^[a-fA-F0-9]{64}$/.test(values['--sha256'])) throw new Error('sha256 must be a 64-digit hexadecimal archive checksum');
  const destination = values['--remote-dir'];
  if (!destination.startsWith('/') || /[\r\n\0]/.test(destination) || destination === '/' || posix.normalize(destination) !== destination || destination.endsWith('/')) throw new Error('remote-dir must be a normalized absolute POSIX version directory');
  if (destination.split('/').length < 4) throw new Error('remote-dir must be a dedicated versioned directory, not a top-level system directory');
  return { host: values['--host'], archive: resolve(values['--archive']), sha256: values['--sha256'].toLowerCase(), remoteDir: destination };
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// tarfile exposes final PAX/GNU names, entry kinds and exact uncompressed bytes;
// nothing is extracted locally, and hard links/symbolic links are never admitted.
const INSPECT = String.raw`
import hashlib, json, re, sys, tarfile
archive, expected_version = sys.argv[1:]
def reject(message):
    raise ValueError(message)
def relative_path(value):
    return isinstance(value, str) and value and not value.startswith('/') and chr(92) not in value and not any(ord(c) < 32 for c in value) and all(x not in ('', '.', '..') for x in value.split('/'))
with tarfile.open(archive, mode='r:gz') as source:
    members = source.getmembers()
    if len(members) > 20000: reject('Too many archive entries')
    inventory = {}
    seen = set()
    total = 0
    for item in members:
        name = item.name.rstrip('/') if item.isdir() else item.name
        if not relative_path(name) or not (name == 'dsh-ssh-helper' or name.startswith('dsh-ssh-helper/')): reject('Unsafe archive path: ' + repr(name))
        if name in seen: reject('Duplicate archive entry: ' + name)
        seen.add(name)
        if not (item.isdir() or item.isfile()): reject('Links and special archive entries are forbidden: ' + name)
        if item.mode & 0o7022: reject('Unsafe archive permissions: ' + name)
        if item.isfile():
            total += item.size
            if item.size > 1024**3 or total > 2 * 1024**3: reject('Archive payload exceeds size budget')
            inventory[name[len('dsh-ssh-helper/'):]] = item
    manifest_entry = inventory.pop('manifest.json', None)
    if manifest_entry is None or manifest_entry.size > 2 * 1024**2: reject('Missing or oversized manifest.json')
    manifest = json.load(source.extractfile(manifest_entry))
    if manifest.get('format') != 1 or manifest.get('version') != expected_version: reject('Helper version must match plugin: ' + expected_version)
    if manifest.get('dirty') is not False: reject('Refusing a dirty-source helper release')
    if not re.fullmatch('[a-f0-9]{40}', manifest.get('commit', '')): reject('Invalid source commit')
    if manifest.get('target') not in ('node24-linux-x64', 'node24-linux-arm64', 'node24-macos-x64', 'node24-macos-arm64'): reject('Unsupported helper target')
    if not str(manifest.get('nodeVersion', '')).startswith('v24.'): reject('Expected embedded Node 24')
    if not isinstance(manifest.get('protocol'), int) or manifest['protocol'] < 1: reject('Invalid protocol version')
    files = manifest.get('files')
    if not isinstance(files, list) or not files: reject('Missing manifest files')
    declared = set()
    helper_hash = None
    for entry in files:
        path = entry.get('path')
        if not relative_path(path) or path in declared: reject('Invalid or duplicate manifest path')
        declared.add(path)
        if path not in inventory: reject('Missing manifest file: ' + path)
        item = inventory[path]
        if not re.fullmatch('[a-f0-9]{64}', str(entry.get('sha256', ''))): reject('Invalid manifest digest')
        if type(entry.get('mode')) is not int or entry['mode'] != item.mode: reject('Manifest permissions differ: ' + path)
        actual = hashlib.file_digest(source.extractfile(item), 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else None
        if actual is None:
            h = hashlib.sha256()
            with source.extractfile(item) as data:
                for chunk in iter(lambda: data.read(1024**2), b''): h.update(chunk)
            actual = h.hexdigest()
        if actual != entry['sha256']: reject('Payload checksum differs: ' + path)
        if path == 'dsh-ssh-helper':
            if not item.mode & 0o100: reject('Helper is not executable')
            helper_hash = actual
    if declared != set(inventory): reject('Archive has undeclared files')
    if helper_hash is None or 'native/system/package.json' not in declared: reject('Missing runtime payload')
    print(json.dumps({'helperHash': helper_hash, 'target': manifest['target'], 'version': manifest['version'], 'commit': manifest['commit']}))
`;

/** Verify a private snapshot before opening a network connection. */
export async function inspectArchive(path, expectedHash) {
  const size = (await stat(path)).size;
  if (size > 1024 ** 3) throw new Error('Compressed archive exceeds 1 GiB');
  if (await digest(path) !== expectedHash) throw new Error('Archive SHA-256 does not match --sha256');
  const { stdout } = await run('python3', ['-c', INSPECT, path, SUPPORTED_VERSION], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function ssh(host, command) {
  return run('ssh', [...SSH_OPTIONS, host, command], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
}

async function upload(host, path, remoteArchive) {
  const child = spawn('ssh', [...SSH_OPTIONS, host, `umask 077; cat > ${quote(remoteArchive)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8192); });
  const completion = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? accept() : reject(new Error(`Archive upload failed (${code}): ${diagnostics}`)));
  });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
  timer.unref();
  try { await Promise.all([pipeline(createReadStream(path), child.stdin), completion]); }
  catch (error) { child.kill('SIGTERM'); throw error; }
  finally { clearTimeout(timer); }
}

/** Deploy a verified archive into a fresh version directory, without replaying failures. */
export async function deploy(options) {
  const local = await mkdtemp(join(tmpdir(), 'dsh-helper-deploy-'));
  let stage;
  const lock = `${options.remoteDir}.install-lock`;
  try {
    const snapshot = join(local, 'helper.tar.gz');
    await copyFile(options.archive, snapshot);
    const metadata = await inspectArchive(snapshot, options.sha256);
    const parent = posix.dirname(options.remoteDir);
    const { stdout } = await ssh(options.host, `set -eu
umask 077
mkdir -p ${quote(parent)}
mkdir ${quote(lock)}
if [ -e ${quote(options.remoteDir)} ] || [ -L ${quote(options.remoteDir)} ]; then rmdir ${quote(lock)}; echo 'Install directory already exists' >&2; exit 1; fi
if stage=$(mktemp -d ${quote(parent + '/.dsh-helper-install.XXXXXX')}); then printf '%s\\n' "$stage"; else rmdir ${quote(lock)}; exit 1; fi`);
    const candidate = stdout.trim();
    if (!candidate.startsWith(parent + '/.dsh-helper-install.') || !/^[a-zA-Z0-9]+$/.test(candidate.slice((parent + '/.dsh-helper-install.').length))) throw new Error('Unexpected SSH staging directory response; staging cleanup requires manual inspection');
    stage = candidate;
    await upload(options.host, snapshot, `${stage}/archive.tar.gz`);
    const system = metadata.target.includes('-linux-') ? 'Linux' : 'Darwin';
    const architecture = metadata.target.endsWith('-x64') ? 'x86_64' : 'arm64';
    const command = `set -eu
stage=${quote(stage)}
lock=${quote(lock)}
trap 'rm -rf "$stage"; rmdir "$lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM
[ "$(uname -s)" = ${quote(system)} ] || { echo 'Helper OS does not match remote host' >&2; exit 1; }
arch=$(uname -m)
[ "$arch" != aarch64 ] || arch=arm64
[ "$arch" = ${quote(architecture)} ] || { echo 'Helper architecture does not match remote host' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/archive.tar.gz"); else actual=$(shasum -a 256 "$stage/archive.tar.gz"); fi
actual=$(printf '%s' "$actual" | cut -d ' ' -f 1)
[ "$actual" = ${quote(options.sha256)} ] || { echo 'Uploaded archive checksum differs' >&2; exit 1; }
mkdir "$stage/payload"
tar -xzf "$stage/archive.tar.gz" -C "$stage/payload" --strip-components=1 --no-same-owner --same-permissions
[ -x "$stage/payload/dsh-ssh-helper" ]
if [ -e ${quote(options.remoteDir)} ] || [ -L ${quote(options.remoteDir)} ]; then echo 'Install directory appeared during upload' >&2; exit 1; fi
mv "$stage/payload" ${quote(options.remoteDir)}
`;
    await ssh(options.host, command);
    stage = undefined;
    return { host: options.host, helper: `${options.remoteDir}/dsh-ssh-helper`, helperHash: metadata.helperHash, launch: { kind: 'executable' }, version: metadata.version, commit: metadata.commit };
  } finally {
    if (stage) {
      // A failed final SSH may already have installed the target. Never remove it.
      await ssh(options.host, `rm -rf ${quote(stage)}; rmdir ${quote(lock)} 2>/dev/null || true`).catch(error => { process.stderr.write(`Staging cleanup could not be confirmed: ${error.message}\n`); });
    }
    await rm(local, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === null) process.stdout.write(HELP);
    else process.stdout.write(JSON.stringify(await deploy(options), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`deploy-helper: ${error.message}\n`);
    process.exitCode = 1;
  }
}
