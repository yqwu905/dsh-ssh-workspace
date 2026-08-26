import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxEnforcement, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SFTPWrapper } from 'ssh2'
import {
  sftpChmod,
  sftpCode,
  sftpMove,
  sftpReadFile,
  sftpStat,
  sftpUnlink,
  sftpWriteFile,
} from './sftp.js'
import { buildRemoteCommand } from './ssh-utils.js'

const LANDLOCK_RUN_VERSION = '0.1.1'
const LANDLOCK_FAILURE_EXIT = 125
const LANDLOCK_PARTIAL_NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'
const PROBE_TIMEOUT_MS = 5_000

const LAUNCHER_ASSETS = {
  x64: {
    file: 'landlock-run-linux-x64',
    sha256: 'a752bc72f111fcc573c3e61fb90fa544541dac0ca498d2e279e1630d7c659b31',
  },
  arm64: {
    file: 'landlock-run-linux-arm64',
    sha256: 'f6ae2ad5893e3123f45329ade5518b33c3ac3b102978001ff1c6a6a8ebe2ad9b',
  },
} as const

type LauncherArch = keyof typeof LAUNCHER_ASSETS

interface ControlResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
}

export interface RemoteSandboxHost {
  getSftp(): Promise<SFTPWrapper>
  execControl(command: string, signal?: AbortSignal, maxBytes?: number): Promise<ControlResult>
}

export type RemoteSandboxBackend =
  | { kind: 'bwrap'; enforcement: 'full' }
  | { kind: 'landlock'; enforcement: SandboxEnforcement; runnerPath: string }
  | { kind: 'unavailable'; detail: string }

export type RemoteSandboxProbe =
  | { usable: true; backend: Exclude<RemoteSandboxBackend, { kind: 'unavailable' }> }
  | { usable: false; detail: string }

const BWRAP_DENIAL_SIGNATURES = ['read-only file system'] as const
const BWRAP_RUNNER_FAILURE_RULES = [{ fatalSignatures: ['bwrap: '] }] as const
const LANDLOCK_DENIAL_SIGNATURES = ['permission denied'] as const
const LANDLOCK_RUNNER_FAILURE_RULES = [{
  allowedExitCodes: [LANDLOCK_FAILURE_EXIT],
  fatalSignatures: ['landlock-run: '],
  informationalLines: [LANDLOCK_PARTIAL_NOTICE],
}] as const

/** Build a bubblewrap profile whose paths belong to the SSH execution world. */
export function remoteBwrapArgv(
  argv: readonly string[],
  policy: SandboxPolicy,
  remoteWorkspaceRoot: string,
): string[] {
  const profile = [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ]
  if (policy.mode === 'workspace-write') {
    profile.push('--tmpfs', '/tmp', '--bind', remoteWorkspaceRoot, remoteWorkspaceRoot)
  }
  return [...profile, '--', ...argv]
}

/** Build the DSH Landlock launcher's equivalent remote file-effect profile. */
export function remoteLandlockArgv(
  argv: readonly string[],
  policy: SandboxPolicy,
  remoteWorkspaceRoot: string,
  runnerPath: string,
): string[] {
  const profile = [runnerPath, '--ro', '/', '--rw', '/dev/null']
  if (policy.mode === 'workspace-write') {
    profile.push('--rw', '/tmp', '--rw', remoteWorkspaceRoot)
  }
  return [...profile, '--', ...argv]
}

/** Select bwrap first and use Landlock only after a functional bwrap failure. */
export async function selectRemoteSandbox(
  probeBwrap: () => Promise<RemoteSandboxProbe>,
  prepareLandlock: () => Promise<RemoteSandboxProbe>,
): Promise<RemoteSandboxBackend> {
  const bwrap = await captureProbe('bwrap', probeBwrap)
  if (bwrap.usable) return bwrap.backend
  const landlock = await captureProbe('Landlock', prepareLandlock)
  if (landlock.usable) return landlock.backend
  return {
    kind: 'unavailable',
    detail: `SSH remote bwrap probe failed: ${bwrap.detail}; Landlock fallback failed: ${landlock.detail}`,
  }
}

/** Probe and prepare the confinement backend once while the SSH server starts. */
export async function prepareRemoteSandbox(host: RemoteSandboxHost): Promise<RemoteSandboxBackend> {
  return await selectRemoteSandbox(
    async () => await probeBwrap(host),
    async () => await prepareLandlock(host),
  )
}

/** Wrap a command with the backend selected for its SSH server. */
export function confineRemoteArgv(
  argv: readonly string[],
  policy: SandboxPolicy,
  remoteWorkspaceRoot: string,
  backend: RemoteSandboxBackend,
): ConfinedArgv {
  if (backend.kind === 'unavailable') {
    throw new SandboxUnavailableError(policy.mode, backend.detail)
  }
  if (backend.kind === 'bwrap') {
    return {
      argv: remoteBwrapArgv(argv, policy, remoteWorkspaceRoot),
      enforcement: backend.enforcement,
      denialSignatures: BWRAP_DENIAL_SIGNATURES,
      runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES,
    }
  }
  return {
    argv: remoteLandlockArgv(argv, policy, remoteWorkspaceRoot, backend.runnerPath),
    enforcement: backend.enforcement,
    denialSignatures: LANDLOCK_DENIAL_SIGNATURES,
    runnerFailureRules: LANDLOCK_RUNNER_FAILURE_RULES,
  }
}

async function captureProbe(label: string, probe: () => Promise<RemoteSandboxProbe>): Promise<RemoteSandboxProbe> {
  try {
    return await probe()
  } catch (error: unknown) {
    return { usable: false, detail: `${label} preparation error: ${oneLine(error)}` }
  }
}

async function probeBwrap(host: RemoteSandboxHost): Promise<RemoteSandboxProbe> {
  const argv = remoteBwrapArgv(
    ['/bin/sh', '-c', ':'],
    { mode: 'read-only', workspaceRoot: '/' },
    '/',
  )
  const result = await runProbe(host, argv)
  if (result.exitCode === 0) return { usable: true, backend: { kind: 'bwrap', enforcement: 'full' } }
  return { usable: false, detail: controlFailure(result) }
}

async function prepareLandlock(host: RemoteSandboxHost): Promise<RemoteSandboxProbe> {
  const arch = await remoteArch(host)
  const runnerPath = await installLandlockRunner(host, arch)
  const result = await runProbe(host, [runnerPath, '--probe'])
  if (result.exitCode !== 0) return { usable: false, detail: controlFailure(result) }
  const report = `${result.stdout}\n${result.stderr}`
  const enforcement: SandboxEnforcement = /partially enforced/iu.test(report) ? 'partial' : 'full'
  return { usable: true, backend: { kind: 'landlock', enforcement, runnerPath } }
}

async function runProbe(host: RemoteSandboxHost, argv: readonly string[]): Promise<ControlResult> {
  return await host.execControl(
    buildRemoteCommand(argv, '/'),
    AbortSignal.timeout(PROBE_TIMEOUT_MS),
    16_384,
  )
}

async function remoteArch(host: RemoteSandboxHost): Promise<LauncherArch> {
  const result = await runProbe(host, [
    '/bin/sh',
    '-c',
    'printf "%s\\n" "$(uname -s)" "$(uname -m)"',
  ])
  if (result.exitCode !== 0) throw new Error(`remote platform probe failed: ${controlFailure(result)}`)
  const lines = result.stdout.trim().split(/\r?\n/u)
  const [system, machine] = lines.slice(-2)
  if (system !== 'Linux') throw new Error(`unsupported remote platform ${JSON.stringify(system ?? '')}`)
  if (machine === 'x86_64' || machine === 'amd64') return 'x64'
  if (machine === 'aarch64' || machine === 'arm64') return 'arm64'
  throw new Error(`unsupported remote Linux architecture ${JSON.stringify(machine ?? '')}`)
}

async function installLandlockRunner(host: RemoteSandboxHost, arch: LauncherArch): Promise<string> {
  const asset = LAUNCHER_ASSETS[arch]
  const localPath = fileURLToPath(new URL(`../assets/${asset.file}`, import.meta.url))
  const payload = await readFile(localPath)
  const digest = createHash('sha256').update(payload).digest('hex')
  if (digest !== asset.sha256) {
    throw new Error(`bundled ${asset.file} failed its SHA-256 integrity check`)
  }

  const cache = await remoteCacheDirectory(host)
  const remotePath = posix.join(
    cache,
    `landlock-run-${LANDLOCK_RUN_VERSION}-${arch}-${digest.slice(0, 16)}`,
  )
  const sftp = await host.getSftp()
  const existing = await inspectRemoteFile(sftp, remotePath, payload.length)
  if (matchesDigest(existing.payload, digest)) {
    await sftpChmod(sftp, remotePath, 0o500)
    return remotePath
  }

  const stage = `${remotePath}.tmp-${randomUUID()}`
  try {
    await sftpWriteFile(sftp, stage, payload, { mode: 0o500 })
    await sftpChmod(sftp, stage, 0o500)
    if (existing.exists) await sftpUnlink(sftp, remotePath)
    try {
      await sftpMove(sftp, stage, remotePath)
    } catch (error: unknown) {
      const raced = await inspectRemoteFile(sftp, remotePath, payload.length)
      if (!matchesDigest(raced.payload, digest)) throw error
      await sftpUnlink(sftp, stage).catch(() => {})
    }
    await sftpChmod(sftp, remotePath, 0o500)
    const installed = await sftpReadFile(sftp, remotePath)
    if (createHash('sha256').update(installed).digest('hex') !== digest) {
      throw new Error('uploaded Landlock runner failed its SHA-256 verification')
    }
    return remotePath
  } catch (error: unknown) {
    await sftpUnlink(sftp, stage).catch(() => {})
    throw error
  }
}

async function remoteCacheDirectory(host: RemoteSandboxHost): Promise<string> {
  const script = [
    'set -eu',
    ': "${HOME:?HOME is not set}"',
    'umask 077',
    'dsh_cache="$HOME/.cache/dsh-ssh-workspace"',
    'mkdir -p -- "$dsh_cache"',
    'chmod 700 -- "$dsh_cache"',
    'cd -P "$dsh_cache"',
    'pwd',
  ].join('\n')
  const result = await runProbe(host, ['/bin/sh', '-c', script])
  if (result.exitCode !== 0) throw new Error(`remote cache setup failed: ${controlFailure(result)}`)
  const directory = result.stdout.trim().split(/\r?\n/u).at(-1)
  if (directory === undefined || !posix.isAbsolute(directory)) {
    throw new Error(`remote cache setup returned an invalid path: ${JSON.stringify(result.stdout)}`)
  }
  return posix.normalize(directory)
}

interface RemoteFileInspection {
  exists: boolean
  payload?: Buffer
}

async function inspectRemoteFile(
  sftp: SFTPWrapper,
  path: string,
  expectedSize: number,
): Promise<RemoteFileInspection> {
  try {
    const attrs = await sftpStat(sftp, path)
    if (!attrs.isFile() || attrs.size !== expectedSize) return { exists: true }
    return { exists: true, payload: await sftpReadFile(sftp, path) }
  } catch (error: unknown) {
    const code = sftpCode(error)
    if (code === 2 || code === 'ENOENT') return { exists: false }
    throw error
  }
}

function matchesDigest(payload: Buffer | undefined, expected: string): boolean {
  return payload !== undefined && createHash('sha256').update(payload).digest('hex') === expected
}

function controlFailure(result: ControlResult): string {
  const output = `${result.stderr}\n${result.stdout}`.trim()
  const status = result.signal === null
    ? `exit ${result.exitCode ?? 'unknown'}`
    : `signal ${result.signal}`
  return output.length === 0 ? status : `${status}: ${oneLine(output)}`
}

function oneLine(value: unknown): string {
  const compact = String(value).replaceAll(/\s+/gu, ' ').trim()
  if (compact.length === 0) return 'no diagnostic output'
  return compact.length <= 1_024 ? compact : `${compact.slice(0, 1_021)}...`
}
