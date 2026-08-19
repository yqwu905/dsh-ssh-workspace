import { mkdirSync, realpathSync } from 'node:fs'
import { access, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { posix } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { WorkspacePathMapper } from './paths.js'
import { hostKeyFingerprint, normalizeFingerprint } from './ssh-utils.js'

export interface WorkspaceConfig {
  /** Existing absolute path on the SSH server. */
  path: string
  /** Optional display title used on first registration. */
  title?: string
}

export interface Config {
  host: string
  port?: number
  username: string
  /** Absolute remote boundary shared by filesystem and process providers. */
  root: string
  /** Host-only mirror root used to satisfy DSH's local workspace registry. */
  anchorRoot?: string
  /** Remote directories registered as workspaces at boot. */
  workspaces?: WorkspaceConfig[]
  /** Local private-key path. Falls back to SSH_AUTH_SOCK, then common key files. */
  privateKeyPath?: string
  /** Environment variable holding the private-key passphrase. */
  passphraseEnv?: string
  /** Environment variable holding a password. Plaintext passwords are intentionally not accepted. */
  passwordEnv?: string
  /** ssh-agent socket path. Defaults to SSH_AUTH_SOCK. */
  agent?: string
  /** Verified OpenSSH SHA256 fingerprint, for example SHA256:abc.... */
  hostKeySha256?: string
  /** Explicit opt-out from host-key verification. */
  acceptUnknownHostKey?: boolean
  readyTimeoutMs?: number
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
}

interface ResolvedConfig {
  host: string
  port: number
  username: string
  root: string
  anchorRoot: string
  workspaces: WorkspaceConfig[]
  privateKeyPath?: string
  passphraseEnv?: string
  passwordEnv?: string
  agent?: string
  hostKeySha256?: string
  acceptUnknownHostKey: boolean
  readyTimeoutMs: number
  keepaliveIntervalMs: number
  keepaliveCountMax: number
}

interface SchemaResolvedConfig extends Config {
  port: number
  workspaces: WorkspaceConfig[]
  acceptUnknownHostKey: boolean
  readyTimeoutMs: number
  keepaliveIntervalMs: number
  keepaliveCountMax: number
}

export interface ControlResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sshWorkspace: SshWorkspaceRuntime
  }
}

function serverSlug(username: string, host: string, port: number): string {
  const slug = `${username}@${host}-${port}`.replaceAll(/[^A-Za-z0-9@._-]+/gu, '_')
  return slug.length > 0 ? slug : 'ssh-server'
}

async function firstReadableKey(configured?: string): Promise<string | undefined> {
  if (configured !== undefined) return resolve(expandHomePath(configured))
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

/** Shared SSH owner. The filesystem and process providers always use this one connection world. */
export class SshWorkspaceRuntime extends Service {
  static Config: z<Config> = z.object({
    host: z.string().required(),
    port: z.number().default(22),
    username: z.string().required(),
    root: z.string().required(),
    anchorRoot: z.string(),
    workspaces: z.array(z.object({
      path: z.string().required(),
      title: z.string(),
    })).default([]),
    privateKeyPath: z.string(),
    passphraseEnv: z.string(),
    passwordEnv: z.string(),
    agent: z.string(),
    hostKeySha256: z.string(),
    acceptUnknownHostKey: z.boolean().default(false),
    readyTimeoutMs: z.number().default(20_000),
    keepaliveIntervalMs: z.number().default(10_000),
    keepaliveCountMax: z.number().default(3),
  })

  readonly config: ResolvedConfig
  readonly paths: WorkspacePathMapper

  private connection: Promise<Client> | undefined
  private activeClient: Client | undefined
  private sftpConnection: Promise<SFTPWrapper> | undefined
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sshWorkspace')
    const resolvedConfig = config as SchemaResolvedConfig
    const slug = serverSlug(config.username ?? '', config.host ?? '', resolvedConfig.port)
    this.config = {
      host: config.host,
      port: resolvedConfig.port,
      username: config.username,
      root: resolvedConfig.root,
      anchorRoot: resolve(config.anchorRoot ?? dshHomePath('ssh-workspaces', slug)),
      workspaces: resolvedConfig.workspaces,
      ...(config.privateKeyPath !== undefined ? { privateKeyPath: config.privateKeyPath } : {}),
      ...(config.passphraseEnv !== undefined ? { passphraseEnv: config.passphraseEnv } : {}),
      ...(config.passwordEnv !== undefined ? { passwordEnv: config.passwordEnv } : {}),
      ...(config.agent !== undefined ? { agent: config.agent } : {}),
      ...(config.hostKeySha256 !== undefined ? { hostKeySha256: config.hostKeySha256 } : {}),
      acceptUnknownHostKey: resolvedConfig.acceptUnknownHostKey,
      readyTimeoutMs: resolvedConfig.readyTimeoutMs,
      keepaliveIntervalMs: resolvedConfig.keepaliveIntervalMs,
      keepaliveCountMax: resolvedConfig.keepaliveCountMax,
    }
    this.validateConfig()
    // DSH's workspace registry stores fs.realpath()-canonical host paths. Do
    // the same before constructing the mapper, otherwise host aliases such as
    // macOS /tmp -> /private/tmp make a valid registered anchor look outside
    // the SSH root when it later arrives as a subprocess cwd.
    mkdirSync(this.config.anchorRoot, { recursive: true, mode: 0o700 })
    this.config.anchorRoot = realpathSync(this.config.anchorRoot)
    this.paths = new WorkspacePathMapper(this.config.root, this.config.anchorRoot)

    ctx.effect(() => async () => this.disposeConnection(), 'ssh workspace connection teardown')
  }

  protected async [Service.init](): Promise<void> {
    await mkdir(this.paths.anchorRoot, { recursive: true, mode: 0o700 })
    const sftp = await this.getSftp()
    const canonicalRoot = await this.realpath(sftp, this.paths.remoteRoot)
    if (canonicalRoot !== this.paths.remoteRoot) {
      throw new Error(
        `dsh-ssh-workspace: root must use its canonical server path; configured ${this.paths.remoteRoot}, canonical ${canonicalRoot}`,
      )
    }
    const root = await this.stat(sftp, this.paths.remoteRoot)
    if (!root.isDirectory()) {
      throw new Error(`dsh-ssh-workspace: configured root is not a directory: ${this.paths.remoteRoot}`)
    }
    for (const workspace of this.config.workspaces) {
      const remote = await this.requireRemoteDirectory(workspace.path)
      await this.materializeAnchor(remote)
    }
  }

  /** A ready SSH connection, shared by SFTP, process, and PTY calls. */
  async getClient(): Promise<Client> {
    if (this.disposed) throw new Error('dsh-ssh-workspace: SSH runtime is disposing')
    this.connection ??= this.openConnection()
    return await this.connection
  }

  /** A ready SFTP session in the same SSH connection world. */
  async getSftp(): Promise<SFTPWrapper> {
    if (this.disposed) throw new Error('dsh-ssh-workspace: SSH runtime is disposing')
    this.sftpConnection ??= this.getClient().then(client => new Promise<SFTPWrapper>((resolveSftp, reject) => {
      client.sftp((error, sftp) => error === undefined ? resolveSftp(sftp) : reject(error))
    }))
    return await this.sftpConnection
  }

  /** Map and create the empty host-side directory accepted by workspaceRegistry.create(). */
  async materializeAnchor(remotePath: string): Promise<string> {
    const anchor = this.paths.toAnchor(remotePath)
    await mkdir(anchor, { recursive: true, mode: 0o700 })
    return anchor
  }

  /** Existing remote directory assertion shared by workspace and directory-picker plugins. */
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

  /** Small trusted control command, never exposed to the model. */
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
        if (next.length > maxBytes) {
          fail(new Error(`dsh-ssh-workspace: SSH control output exceeded ${maxBytes} bytes`))
        }
        return next
      }
      const onAbort = (): void => fail(signal?.reason ?? new Error('SSH control command aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      client.exec(command, (error, stream) => {
        if (error !== undefined) {
          fail(error)
          return
        }
        channel = stream
        if (settled) {
          stream.close()
          return
        }
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

  private validateConfig(): void {
    if (this.config.host.trim().length === 0) throw new Error('dsh-ssh-workspace: host is required')
    if (this.config.username.trim().length === 0) throw new Error('dsh-ssh-workspace: username is required')
    if (!Number.isInteger(this.config.port) || this.config.port < 1 || this.config.port > 65_535) {
      throw new Error('dsh-ssh-workspace: port must be an integer between 1 and 65535')
    }
    for (const [name, value] of [
      ['readyTimeoutMs', this.config.readyTimeoutMs],
      ['keepaliveIntervalMs', this.config.keepaliveIntervalMs],
      ['keepaliveCountMax', this.config.keepaliveCountMax],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`dsh-ssh-workspace: ${name} must be positive`)
    }
    if (!this.config.acceptUnknownHostKey && this.config.hostKeySha256 === undefined) {
      throw new Error(
        'dsh-ssh-workspace: hostKeySha256 is required; set acceptUnknownHostKey only for an explicitly insecure test host',
      )
    }
    for (const workspace of this.config.workspaces) {
      if (!posix.isAbsolute(workspace.path)) {
        throw new Error(`dsh-ssh-workspace: workspace path must be absolute: ${JSON.stringify(workspace.path)}`)
      }
    }
  }

  private async connectConfig(): Promise<ConnectConfig> {
    const privateKeyPath = await firstReadableKey(this.config.privateKeyPath)
    const privateKey = privateKeyPath === undefined ? undefined : await readFile(privateKeyPath)
    const password = this.config.passwordEnv === undefined ? undefined : process.env[this.config.passwordEnv]
    const passphrase = this.config.passphraseEnv === undefined ? undefined : process.env[this.config.passphraseEnv]
    const agent = this.config.agent ?? process.env.SSH_AUTH_SOCK
    if (this.config.passwordEnv !== undefined && password === undefined) {
      throw new Error(`dsh-ssh-workspace: environment variable ${this.config.passwordEnv} is not set`)
    }
    if (this.config.passphraseEnv !== undefined && passphrase === undefined) {
      throw new Error(`dsh-ssh-workspace: environment variable ${this.config.passphraseEnv} is not set`)
    }
    if (privateKey === undefined && password === undefined && agent === undefined) {
      throw new Error('dsh-ssh-workspace: no SSH authentication method is available')
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
    if (this.disposed) throw new Error('dsh-ssh-workspace: SSH runtime is disposing')
    const client = new Client()
    this.activeClient = client
    return await new Promise<Client>((resolveClient, reject) => {
      let ready = false
      const onError = (error: Error): void => {
        if (!ready) reject(error)
      }
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
        if (!ready) reject(new Error('dsh-ssh-workspace: SSH connection closed before ready'))
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

  private async disposeConnection(): Promise<void> {
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
}

export { WorkspacePathMapper } from './paths.js'
export { buildRemoteCommand, hostKeyFingerprint, normalizeFingerprint, quoteShell } from './ssh-utils.js'
export default SshWorkspaceRuntime
