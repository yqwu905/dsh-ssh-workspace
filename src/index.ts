import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, realpathSync } from 'node:fs'
import { access, chmod, mkdir, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import SshOpenPath from './open-path.js'
import { WorkspacePathMapper } from './paths.js'
import {
  confineRemoteArgv,
  prepareRemoteSandbox,
  type RemoteSandboxBackend,
} from './remote-sandbox.js'
import { hostKeyFingerprint, normalizeFingerprint, quoteShell } from './ssh-utils.js'

export const SSH_SETTINGS_NAMESPACE = 'ssh-workspace'

export interface WorkspaceConfig {
  path: string
  title?: string
}

export type SshAuthMode = 'auto' | 'key' | 'password'

export interface SshServerConfig {
  id: string
  name: string
  host: string
  port?: number
  username: string
  root: string
  authMode?: SshAuthMode
  privateKeyPath?: string
  remoteRipgrepPath?: string
  passwordRef?: string
  passphraseRef?: string
  passwordEnv?: string
  passphraseEnv?: string
  agent?: string
  hostKeySha256?: string
  acceptUnknownHostKey?: boolean
  workspaces?: WorkspaceConfig[]
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
}

/** `servers` is canonical; optional single-server fields preserve existing installs. */
export interface Config {
  anchorRoot?: string
  servers?: SshServerConfig[]
  host?: string
  port?: number
  username?: string
  root?: string
  workspaces?: WorkspaceConfig[]
  privateKeyPath?: string
  remoteRipgrepPath?: string
  passphraseEnv?: string
  passwordEnv?: string
  agent?: string
  hostKeySha256?: string
  acceptUnknownHostKey?: boolean
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
}

export interface ResolvedSshServerConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  root: string
  anchorRoot: string
  authMode: SshAuthMode
  workspaces: WorkspaceConfig[]
  privateKeyPath?: string
  remoteRipgrepPath?: string
  passwordRef?: string
  passphraseRef?: string
  passwordEnv?: string
  passphraseEnv?: string
  agent?: string
  hostKeySha256?: string
  acceptUnknownHostKey: boolean
  readyTimeoutMs: number
  keepaliveIntervalMs: number
  keepaliveCountMax: number
}

interface SchemaResolvedConfig extends Config {
  servers: SshServerConfig[]
}

export interface ControlResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
}

export interface ResolvedSshPath {
  server: SshServerRuntime
  remotePath: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshWorkspace: SshWorkspaceRuntime
  }
}

function serverSlug(value: string): string {
  const slug = value.replaceAll(/[^A-Za-z0-9._-]+/gu, '_')
  return slug.length > 0 ? slug : 'ssh-server'
}

function legacyId(config: Config): string {
  return serverSlug(`${config.username ?? 'user'}@${config.host ?? 'server'}-${config.port ?? 22}`)
}

async function firstReadableKey(configured?: string): Promise<string | undefined> {
  if (configured !== undefined && configured.trim().length > 0) return resolve(expandHomePath(configured))
  for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
    const path = join(homedir(), '.ssh', name)
    try {
      await access(path)
      return path
    } catch {
      // Try the next conventional key.
    }
  }
  return undefined
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

function normalizeServer(raw: SshServerConfig, anchorBase: string): ResolvedSshServerConfig {
  const id = optional(raw.id) ?? serverSlug(`${raw.username}@${raw.host}-${raw.port ?? 22}`)
  const anchor = resolve(anchorBase, serverSlug(id))
  mkdirSync(anchor, { recursive: true, mode: 0o700 })
  const privateKeyPath = optional(raw.privateKeyPath)
  const remoteRipgrepPath = optional(raw.remoteRipgrepPath)
  const passwordRef = optional(raw.passwordRef)
  const passphraseRef = optional(raw.passphraseRef)
  const passwordEnv = optional(raw.passwordEnv)
  const passphraseEnv = optional(raw.passphraseEnv)
  const agent = optional(raw.agent)
  const hostKeySha256 = optional(raw.hostKeySha256)
  return {
    id,
    name: optional(raw.name) ?? id,
    host: raw.host,
    port: raw.port ?? 22,
    username: raw.username,
    root: posix.resolve(raw.root),
    anchorRoot: realpathSync(anchor),
    authMode: raw.authMode ?? 'auto',
    workspaces: raw.workspaces ?? [],
    ...(privateKeyPath !== undefined ? { privateKeyPath } : {}),
    ...(remoteRipgrepPath !== undefined ? { remoteRipgrepPath } : {}),
    ...(passwordRef !== undefined ? { passwordRef } : {}),
    ...(passphraseRef !== undefined ? { passphraseRef } : {}),
    ...(passwordEnv !== undefined ? { passwordEnv } : {}),
    ...(passphraseEnv !== undefined ? { passphraseEnv } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(hostKeySha256 !== undefined ? { hostKeySha256 } : {}),
    acceptUnknownHostKey: raw.acceptUnknownHostKey ?? false,
    readyTimeoutMs: raw.readyTimeoutMs ?? 20_000,
    keepaliveIntervalMs: raw.keepaliveIntervalMs ?? 10_000,
    keepaliveCountMax: raw.keepaliveCountMax ?? 3,
  }
}

function configuredServers(config: Config): SshServerConfig[] {
  if ((config.servers?.length ?? 0) > 0) return config.servers ?? []
  if (optional(config.host) === undefined && optional(config.username) === undefined && optional(config.root) === undefined) {
    return []
  }
  if (config.host === undefined || config.username === undefined || config.root === undefined) {
    throw new Error('dsh-ssh-workspace: legacy host, username, and root must be configured together')
  }
  const id = legacyId(config)
  return [{
    id,
    name: `${config.username}@${config.host}`,
    host: config.host,
    ...(config.port !== undefined ? { port: config.port } : {}),
    username: config.username,
    root: config.root,
    authMode: 'auto',
    ...(config.workspaces !== undefined ? { workspaces: config.workspaces } : {}),
    ...(config.privateKeyPath !== undefined ? { privateKeyPath: config.privateKeyPath } : {}),
    ...(config.remoteRipgrepPath !== undefined ? { remoteRipgrepPath: config.remoteRipgrepPath } : {}),
    ...(config.passphraseEnv !== undefined ? { passphraseEnv: config.passphraseEnv } : {}),
    ...(config.passwordEnv !== undefined ? { passwordEnv: config.passwordEnv } : {}),
    ...(config.agent !== undefined ? { agent: config.agent } : {}),
    ...(config.hostKeySha256 !== undefined ? { hostKeySha256: config.hostKeySha256 } : {}),
    ...(config.acceptUnknownHostKey !== undefined ? { acceptUnknownHostKey: config.acceptUnknownHostKey } : {}),
    ...(config.readyTimeoutMs !== undefined ? { readyTimeoutMs: config.readyTimeoutMs } : {}),
    ...(config.keepaliveIntervalMs !== undefined ? { keepaliveIntervalMs: config.keepaliveIntervalMs } : {}),
    ...(config.keepaliveCountMax !== undefined ? { keepaliveCountMax: config.keepaliveCountMax } : {}),
  }]
}

const workspaceSchema = z.object({
  path: z.string().required(),
  title: z.string(),
})

const serverSchema: z<SshServerConfig> = z.object({
  id: z.string().required(),
  name: z.string().required(),
  host: z.string().required(),
  port: z.number().default(22),
  username: z.string().required(),
  root: z.string().required(),
  authMode: z.union(['auto', 'key', 'password'] as const).default('auto'),
  privateKeyPath: z.string(),
  remoteRipgrepPath: z.string(),
  passwordRef: z.string(),
  passphraseRef: z.string(),
  passwordEnv: z.string(),
  passphraseEnv: z.string(),
  agent: z.string(),
  hostKeySha256: z.string(),
  acceptUnknownHostKey: z.boolean().default(false),
  workspaces: z.array(workspaceSchema).default([]),
  readyTimeoutMs: z.number().default(20_000),
  keepaliveIntervalMs: z.number().default(10_000),
  keepaliveCountMax: z.number().default(3),
})

/** One independently authenticated SSH execution world. */
export class SshServerRuntime {
  readonly paths: WorkspacePathMapper
  private readonly openCacheRoot: string
  private connection: Promise<Client> | undefined
  private activeClient: Client | undefined
  private sftpConnection: Promise<SFTPWrapper> | undefined
  private remoteSandbox: RemoteSandboxBackend = {
    kind: 'unavailable',
    detail: 'SSH remote sandbox capability has not finished initializing',
  }
  private disposed = false

  constructor(private readonly ctx: Context, readonly config: ResolvedSshServerConfig) {
    this.validateConfig()
    this.paths = new WorkspacePathMapper(config.root, config.anchorRoot)
    this.openCacheRoot = resolve(config.anchorRoot, '..', '.open-cache', serverSlug(config.id))
  }

  async initialize(): Promise<void> {
    await mkdir(this.paths.anchorRoot, { recursive: true, mode: 0o700 })
    const sftp = await this.getSftp()
    const canonicalRoot = await this.realpath(sftp, this.paths.remoteRoot)
    if (canonicalRoot !== this.paths.remoteRoot) {
      throw new Error(
        `dsh-ssh-workspace: server ${this.config.id} root must use its canonical path; configured ${this.paths.remoteRoot}, canonical ${canonicalRoot}`,
      )
    }
    const root = await this.stat(sftp, this.paths.remoteRoot)
    if (!root.isDirectory()) {
      throw new Error(`dsh-ssh-workspace: server ${this.config.id} root is not a directory: ${this.paths.remoteRoot}`)
    }
    for (const workspace of this.config.workspaces) {
      const remote = await this.requireRemoteDirectory(workspace.path)
      await this.materializeAnchor(remote)
    }
    this.remoteSandbox = await prepareRemoteSandbox(this)
    if (this.remoteSandbox.kind === 'unavailable') {
      this.ctx.logger.warn(
        `dsh-ssh-workspace: confined Bash is unavailable on server ${this.config.id}: ${this.remoteSandbox.detail}`,
      )
    }
  }

  async getClient(): Promise<Client> {
    if (this.disposed) throw new Error(`dsh-ssh-workspace: server ${this.config.id} is disposing`)
    if (this.connection === undefined) {
      const pending = this.openConnection()
      this.connection = pending
      void pending.catch(() => {
        if (this.connection === pending) {
          this.connection = undefined
          this.sftpConnection = undefined
        }
      })
    }
    return await this.connection
  }

  async getSftp(): Promise<SFTPWrapper> {
    if (this.disposed) throw new Error(`dsh-ssh-workspace: server ${this.config.id} is disposing`)
    if (this.sftpConnection === undefined) {
      const pending = this.getClient().then(client => new Promise<SFTPWrapper>((resolveSftp, reject) => {
        client.sftp((error, sftp) => error === undefined ? resolveSftp(sftp) : reject(error))
      }))
      this.sftpConnection = pending
      void pending.catch(() => {
        if (this.sftpConnection === pending) this.sftpConnection = undefined
      })
    }
    return await this.sftpConnection
  }

  async materializeAnchor(remotePath: string): Promise<string> {
    const anchor = this.paths.toAnchor(remotePath)
    await mkdir(anchor, { recursive: true, mode: 0o700 })
    return anchor
  }

  /**
   * Download a remote target for DSH's host-native path opener. Workspace
   * anchors intentionally contain no files, so they cannot be opened directly
   * by Finder, Explorer, or xdg-open. File snapshots are read-only because
   * edits in a desktop application cannot be synchronized back over SFTP.
   */
  async materializeOpenPath(remotePath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const display = this.paths.toRemote(remotePath)
    const sftp = await this.getSftp()
    const canonical = await this.realpath(sftp, display)
    if (!this.paths.containsRemote(canonical)) {
      throw new Error(`remote open target resolves outside configured root: ${display} -> ${canonical}`)
    }
    const attrs = await this.stat(sftp, canonical)
    const relative = posix.relative(this.paths.remoteRoot, display)
    const snapshot = resolve(this.openCacheRoot, ...relative.split('/').filter(Boolean))
    if (attrs.isDirectory()) {
      await mkdir(snapshot, { recursive: true, mode: 0o700 })
      return snapshot
    }
    if (!attrs.isFile()) throw new Error(`remote open target is not a regular file: ${display}`)

    await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 })
    const stage = `${snapshot}.dsh-open-${randomUUID()}.tmp`
    try {
      const source = sftp.createReadStream(canonical)
      const destination = createWriteStream(stage, { mode: 0o600 })
      if (signal === undefined) await pipeline(source, destination)
      else await pipeline(source, destination, { signal })
      signal?.throwIfAborted()
      await chmod(stage, 0o400)
      await rename(stage, snapshot)
      return snapshot
    } catch (error: unknown) {
      await unlink(stage).catch(() => {})
      throw error
    }
  }

  async requireRemoteDirectory(path: string): Promise<string> {
    const display = this.paths.toRemote(path)
    const sftp = await this.getSftp()
    const remote = await this.realpath(sftp, display)
    if (!this.paths.containsRemote(remote)) {
      throw new Error(`remote directory resolves outside configured root: ${display} -> ${remote}`)
    }
    const info = await this.stat(sftp, remote)
    if (!info.isDirectory()) throw new Error(`remote path is not a directory: ${display}`)
    return remote
  }

  confineSandbox(
    argv: readonly string[],
    policy: SandboxPolicy,
    remoteWorkspaceRoot: string,
  ): ConfinedArgv {
    return confineRemoteArgv(argv, policy, remoteWorkspaceRoot, this.remoteSandbox)
  }

  async execControl(command: string, signal?: AbortSignal, maxBytes = 256_000): Promise<ControlResult> {
    signal?.throwIfAborted()
    const client = await this.getClient()
    signal?.throwIfAborted()
    return await new Promise<ControlResult>((resolveResult, reject) => {
      let channel: ClientChannel | undefined
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        channel?.close()
        reject(error)
      }
      const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk])
        if (next.length > maxBytes) fail(new Error(`dsh-ssh-workspace: SSH control output exceeded ${maxBytes} bytes`))
        return next
      }
      const onAbort = (): void => fail(signal?.reason ?? new Error('SSH control command aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      client.exec(command, (error, stream) => {
        if (error !== undefined) return fail(error)
        channel = stream
        if (settled) return stream.close()
        stream.on('data', (chunk: Buffer | string) => { stdout = append(stdout, Buffer.from(chunk)) })
        stream.stderr.on('data', (chunk: Buffer | string) => { stderr = append(stderr, Buffer.from(chunk)) })
        stream.once('error', fail)
        stream.once('close', (code: number | null, remoteSignal: string | null) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          resolveResult({
            stdout: stdout.toString('utf8'),
            stderr: stderr.toString('utf8'),
            exitCode: code,
            signal: remoteSignal,
          })
        })
        stream.end()
      })
    })
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('dsh-ssh-workspace: executable must be non-empty')
    signal?.throwIfAborted()
    if (!posix.isAbsolute(command) && command.includes('/')) {
      throw new Error(`dsh-ssh-workspace: command ${JSON.stringify(command)} is a relative path`)
    }
    const pathPrefix = env?.PATH === undefined ? '' : `PATH=${quoteShell(env.PATH)} `
    const probe = posix.isAbsolute(command)
      ? `test -f ${quoteShell(command)} && test -x ${quoteShell(command)} && printf '%s\\n' ${quoteShell(command)}`
      : `${pathPrefix}command -v ${quoteShell(command)}`
    const result = await this.execControl(probe, signal, 16_384)
    if (result.exitCode !== 0) {
      throw new Error(`dsh-ssh-workspace: command ${JSON.stringify(command)} was not found on server ${this.config.id}`)
    }
    const resolved = result.stdout.trim().split('\n')[0]
    if (resolved === undefined || !posix.isAbsolute(resolved)) {
      throw new Error(`dsh-ssh-workspace: command ${JSON.stringify(command)} did not resolve to an absolute remote path`)
    }
    return resolved
  }

  /** Adapt host-packaged tool binaries to an executable in this SSH world. */
  async adaptArgv(argv: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    const executable = argv[0]
    if (executable === undefined) return argv
    if (/[/\\]@vscode[/\\]ripgrep-[^/\\]+[/\\]bin[/\\]rg(?:\.exe)?$/iu.test(executable)) {
      const remote = await this.resolveExecutable(this.config.remoteRipgrepPath ?? 'rg', undefined, signal)
      const args = argv.slice(1).map(value => this.paths.containsAnchor(value) ? this.paths.toRemote(value) : value)
      // The local subprocess provider attaches `stdin: ignore` to /dev/null, so
      // ripgrep with no explicit target walks cwd. An SSH exec channel instead
      // presents a readable (then closed) pipe; ripgrep would search that empty
      // stdin and report no matches. Make the implicit grep target explicit.
      if (args.includes('--json') && !args.includes('--')) args.push('--', '.')
      return [remote, ...args]
    }
    return argv
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const client = this.activeClient ?? await this.connection?.catch(() => undefined)
    if (client === undefined) return
    await new Promise<void>((resolveDone) => {
      const timer = setTimeout(() => {
        client.destroy()
        resolveDone()
      }, 2_000)
      timer.unref()
      client.once('close', () => {
        clearTimeout(timer)
        resolveDone()
      })
      client.end()
    })
  }

  private validateConfig(): void {
    if (!/^[A-Za-z0-9._-]+$/u.test(this.config.id)) {
      throw new Error(`dsh-ssh-workspace: invalid server id ${JSON.stringify(this.config.id)}`)
    }
    if (this.config.host.trim().length === 0) throw new Error(`dsh-ssh-workspace: server ${this.config.id} host is required`)
    if (this.config.username.trim().length === 0) throw new Error(`dsh-ssh-workspace: server ${this.config.id} username is required`)
    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65_535) {
      throw new Error(`dsh-ssh-workspace: server ${this.config.id} port must be an integer between 1 and 65535`)
    }
    for (const [name, value] of [
      ['readyTimeoutMs', this.config.readyTimeoutMs],
      ['keepaliveIntervalMs', this.config.keepaliveIntervalMs],
      ['keepaliveCountMax', this.config.keepaliveCountMax],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`dsh-ssh-workspace: server ${this.config.id} ${name} must be positive`)
      }
    }
    if (!this.config.acceptUnknownHostKey && this.config.hostKeySha256 === undefined) {
      throw new Error(`dsh-ssh-workspace: server ${this.config.id} hostKeySha256 is required`)
    }
    if (this.config.authMode === 'password' && this.config.passwordRef === undefined && this.config.passwordEnv === undefined) {
      throw new Error(`dsh-ssh-workspace: server ${this.config.id} password mode requires passwordRef`)
    }
    for (const ref of [this.config.passwordRef, this.config.passphraseRef]) {
      if (ref !== undefined) credentialRef(ref)
    }
    for (const workspace of this.config.workspaces) {
      if (!posix.isAbsolute(workspace.path)) {
        throw new Error(`dsh-ssh-workspace: server ${this.config.id} workspace path must be absolute: ${JSON.stringify(workspace.path)}`)
      }
    }
  }

  private async resolveSecret(
    ref: string | undefined,
    env: string | undefined,
    label: string,
    allowMissingCredential = false,
  ): Promise<string | undefined> {
    if (ref !== undefined) {
      const credentials = this.ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error(`dsh-ssh-workspace: credentials service is required to resolve ${label} reference ${ref}`)
      }
      const resolved = await credentials.resolve(credentialRef(ref))
      if (resolved === undefined) {
        if (allowMissingCredential) return undefined
        throw new Error(`dsh-ssh-workspace: ${label} credential ${ref} is not configured`)
      }
      return resolved.value
    }
    if (env === undefined) return undefined
    const value = process.env[env]
    if (value === undefined) throw new Error(`dsh-ssh-workspace: environment variable ${env} is not set`)
    return value
  }

  private async connectConfig(): Promise<ConnectConfig> {
    const password = this.config.authMode === 'key'
      ? undefined
      : await this.resolveSecret(
          this.config.passwordRef,
          this.config.passwordEnv,
          'password',
          this.config.authMode === 'auto',
        )
    const passphrase = this.config.authMode === 'password'
      ? undefined
      : await this.resolveSecret(this.config.passphraseRef, this.config.passphraseEnv, 'passphrase')
    const privateKeyPath = this.config.authMode === 'password'
      ? undefined
      : await firstReadableKey(this.config.privateKeyPath)
    const privateKey = privateKeyPath === undefined ? undefined : await readFile(privateKeyPath)
    const agent = this.config.authMode === 'password' ? undefined : this.config.agent ?? process.env.SSH_AUTH_SOCK
    if (privateKey === undefined && password === undefined && agent === undefined) {
      throw new Error(`dsh-ssh-workspace: server ${this.config.id} has no available SSH authentication method`)
    }
    const expected = this.config.hostKeySha256 === undefined
      ? undefined
      : normalizeFingerprint(this.config.hostKeySha256)
    return {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.readyTimeoutMs,
      keepaliveInterval: this.config.keepaliveIntervalMs,
      keepaliveCountMax: this.config.keepaliveCountMax,
      ...(privateKey !== undefined ? { privateKey } : {}),
      ...(passphrase !== undefined ? { passphrase } : {}),
      ...(password !== undefined ? { password } : {}),
      ...(agent !== undefined ? { agent } : {}),
      hostVerifier: (key: Buffer) => expected === undefined || hostKeyFingerprint(key) === expected,
    }
  }

  private async openConnection(): Promise<Client> {
    const config = await this.connectConfig()
    if (this.disposed) throw new Error(`dsh-ssh-workspace: server ${this.config.id} is disposing`)
    const client = new Client()
    this.activeClient = client
    return await new Promise<Client>((resolveClient, reject) => {
      let ready = false
      const onError = (error: Error): void => { if (!ready) reject(error) }
      client.once('ready', () => {
        ready = true
        resolveClient(client)
      })
      client.on('error', onError)
      client.once('close', () => {
        if (this.activeClient === client) {
          this.activeClient = undefined
          this.connection = undefined
          this.sftpConnection = undefined
        }
        if (!ready) reject(new Error(`dsh-ssh-workspace: server ${this.config.id} connection closed before ready`))
      })
      client.connect(config)
    })
  }

  private stat(sftp: SFTPWrapper, path: string): Promise<import('ssh2').Stats> {
    return new Promise((resolveStat, reject) => {
      sftp.stat(path, (error, attrs) => error === undefined ? resolveStat(attrs) : reject(error))
    })
  }

  private realpath(sftp: SFTPWrapper, path: string): Promise<string> {
    return new Promise((resolvePath, reject) => {
      sftp.realpath(path, (error, canonical) => error === undefined ? resolvePath(canonical) : reject(error))
    })
  }
}

/** Multi-server registry and path router shared by filesystem, process, and picker providers. */
export class SshWorkspaceRuntime extends Service {
  static Config: z<Config> = z.object({
    anchorRoot: z.string(),
    servers: z.array(serverSchema).default([]),
    host: z.string(),
    port: z.number().default(22),
    username: z.string(),
    root: z.string(),
    workspaces: z.array(workspaceSchema).default([]),
    privateKeyPath: z.string(),
    remoteRipgrepPath: z.string(),
    passphraseEnv: z.string(),
    passwordEnv: z.string(),
    agent: z.string(),
    hostKeySha256: z.string(),
    acceptUnknownHostKey: z.boolean().default(false),
    readyTimeoutMs: z.number().default(20_000),
    keepaliveIntervalMs: z.number().default(10_000),
    keepaliveCountMax: z.number().default(3),
  })

  private source: () => Config
  private readonly entry: Config
  private readonly anchorBase: string
  private readonly registry = new Map<string, SshServerRuntime>()
  private disposed = false
  private started = false
  private reconfigureTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sshWorkspace')
    this.entry = config as SchemaResolvedConfig
    this.source = () => this.entry
    const anchorBase = resolve(config.anchorRoot ?? dshHomePath('ssh-workspaces'))
    mkdirSync(anchorBase, { recursive: true, mode: 0o700 })
    this.anchorBase = realpathSync(anchorBase)
    this.replaceRegistry(this.entry)

    installSettingsSection(
      ctx,
      settingsNamespace(SSH_SETTINGS_NAMESPACE),
      SshWorkspaceRuntime.Config,
      this.entry,
      {
        setSource: source => { this.source = source },
        onChange: () => { this.scheduleReconfigure() },
        validate: value => { this.validateConfig(value) },
      },
    )
    // This child waits for the API gateway without making the SSH runtime
    // depend on it (the gateway reaches filesystem tools and would cycle).
    ctx.plugin(SshOpenPath)
    ctx.effect(() => async () => {
      this.disposed = true
      await this.reconfigureTail.catch(() => {})
      const servers = [...this.registry.values()]
      this.registry.clear()
      await Promise.allSettled(servers.map(server => server.dispose()))
    }, 'ssh workspace registry teardown')
  }

  get config(): Config {
    return this.source()
  }

  get anchorRoot(): string {
    return this.anchorBase
  }

  listServers(): readonly SshServerRuntime[] {
    return [...this.registry.values()]
  }

  getServer(id: string): SshServerRuntime {
    const server = this.registry.get(id)
    if (server === undefined) throw new Error(`dsh-ssh-workspace: unknown SSH server ${JSON.stringify(id)}`)
    return server
  }

  defaultServer(): SshServerRuntime {
    const server = this.registry.values().next().value as SshServerRuntime | undefined
    if (server === undefined) throw new Error('dsh-ssh-workspace: configure at least one SSH server')
    return server
  }

  /** Resolve only paths explicitly routed by an SSH workspace anchor. */
  resolveAnchoredPath(path: string, cwd?: string): ResolvedSshPath | undefined {
    const servers = this.listServers()
    const pathServer = isAbsolute(path)
      ? servers.find(server => server.paths.containsAnchor(path))
      : undefined
    if (pathServer !== undefined) {
      return { server: pathServer, remotePath: pathServer.paths.toRemote(path) }
    }
    const cwdServer = cwd !== undefined && isAbsolute(cwd)
      ? servers.find(server => server.paths.containsAnchor(cwd))
      : undefined
    if (cwdServer === undefined) return undefined
    return { server: cwdServer, remotePath: cwdServer.paths.toRemote(path, cwd) }
  }

  resolvePath(path: string, cwd?: string): ResolvedSshPath {
    if (path.trim().length === 0) throw new Error('dsh-ssh-workspace: path must be non-empty')
    const anchored = this.resolveAnchoredPath(path, cwd)
    if (anchored !== undefined) return anchored
    const servers = this.listServers()
    if (posix.isAbsolute(path)) {
      const matches = servers.filter(server => server.paths.containsRemote(path))
      if (matches.length === 1 && matches[0] !== undefined) {
        return { server: matches[0], remotePath: matches[0].paths.toRemote(path) }
      }
      if (matches.length > 1) {
        throw new Error(`dsh-ssh-workspace: remote path ${JSON.stringify(path)} matches multiple servers; use a workspace cwd`)
      }
    }
    if (!posix.isAbsolute(path) && servers.length === 1 && servers[0] !== undefined) {
      return { server: servers[0], remotePath: servers[0].paths.toRemote(path, cwd) }
    }
    throw new Error(`dsh-ssh-workspace: cannot choose an SSH server for ${JSON.stringify(path)}; use a configured workspace cwd`)
  }

  resolveAnchor(path: string): ResolvedSshPath {
    const server = this.listServers().find(candidate => candidate.paths.containsAnchor(path))
    if (server === undefined) throw new Error(`dsh-ssh-workspace: path is not inside an SSH server anchor: ${JSON.stringify(path)}`)
    return { server, remotePath: server.paths.toRemote(path) }
  }

  protected async [Service.init](): Promise<void> {
    await this.reconfigureTail
    await Promise.all(this.listServers().map(server => server.initialize()))
    this.started = true
  }

  private validateConfig(config: Config): void {
    const seen = new Set<string>()
    for (const raw of configuredServers(config)) {
      const server = normalizeServer(raw, this.anchorBase)
      if (seen.has(server.id)) throw new Error(`dsh-ssh-workspace: duplicate server id ${JSON.stringify(server.id)}`)
      seen.add(server.id)
      void new SshServerRuntime(this.ctx, server)
    }
  }

  private replaceRegistry(config: Config): SshServerRuntime[] {
    const next = new Map<string, SshServerRuntime>()
    for (const raw of configuredServers(config)) {
      const server = new SshServerRuntime(this.ctx, normalizeServer(raw, this.anchorBase))
      if (next.has(server.config.id)) throw new Error(`dsh-ssh-workspace: duplicate server id ${JSON.stringify(server.config.id)}`)
      next.set(server.config.id, server)
    }
    const previous = [...this.registry.values()]
    this.registry.clear()
    for (const [id, server] of next) this.registry.set(id, server)
    return previous
  }

  private scheduleReconfigure(): void {
    if (this.disposed) return
    this.reconfigureTail = this.reconfigureTail.then(async () => {
      const previous = this.replaceRegistry(this.source())
      await Promise.allSettled(previous.map(server => server.dispose()))
      if (!this.started) return
      const results = await Promise.allSettled(this.listServers().map(server => server.initialize()))
      for (const result of results) {
        if (result.status === 'rejected') this.ctx.logger.warn(result.reason)
      }
    }).catch((error: unknown) => {
      this.ctx.logger.warn('dsh-ssh-workspace: failed to apply SSH settings')
      this.ctx.logger.warn(error)
    })
  }
}

export function encodeSshTarget(serverId: string, remotePath: string): string {
  return `dsh-ssh:${Buffer.from(serverId, 'utf8').toString('base64url')}:${remotePath}`
}

export function decodeSshTarget(value: string): { serverId: string; remotePath: string } {
  const match = /^dsh-ssh:([^:]+):(\/.*)$/u.exec(value)
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`dsh-ssh-workspace: invalid SSH filesystem target ${JSON.stringify(value)}`)
  }
  return { serverId: Buffer.from(match[1], 'base64url').toString('utf8'), remotePath: match[2] }
}

export { WorkspacePathMapper } from './paths.js'
export { buildRemoteCommand, hostKeyFingerprint, normalizeFingerprint, quoteShell } from './ssh-utils.js'
export default SshWorkspaceRuntime
