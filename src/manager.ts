/** Durable SSH identities and real host mount lifecycle for native DSH workspaces. */
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir, symlink, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { persistedState, serverInput, workspaceInput, type ServerRecord, type WorkspaceRecord } from './config.js'
import { discoverConfigHosts } from './ssh-config.js'
import { sshfsArguments } from './sshfs.js'
import { ensureHelper } from './helper-install.js'
import type { SetupPhase } from './helper-bundle.js'
import { checkSandbox, type SandboxChecks } from './sandbox-diagnostics.js'

const run = promisify(execFile)
const wait = (milliseconds: number): Promise<void> => new Promise(done => setTimeout(done, milliseconds))
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
export type ServerStatus = 'disconnected' | 'connecting' | 'installing' | 'connected' | 'error'
export type MountStatus = 'unmounted' | 'mounting' | 'mounted' | 'error'
export type ServerView = ServerRecord & { status: ServerStatus; error?: string; setupPhase?: SetupPhase; sandboxChecks?: SandboxChecks }
export type WorkspaceView = WorkspaceRecord & { status: MountStatus; error?: string }
export interface ManagerState { servers: ServerView[]; workspaces: WorkspaceView[] }
export interface ManagerOptions {
  stateDir: string
  mountRoot: string
  requestTimeoutMs?: number
  mountTimeoutMs?: number
  sshfsBinary?: string
  helperInstallTimeoutMs?: number
}
export interface RemoteProviders { subprocess: SshSubprocessRuntime; sandbox: SshSandboxProvider; fs: SshFileSystem }
interface Remote extends RemoteProviders { ssh: SshConnection; fiber: Fiber; tunnel?: ChildProcess; healthCheck?: NodeJS.Timeout }
interface RuntimeMount { process: ChildProcess; closed: Promise<void> }

/** Parse Linux's escaped mountinfo fields without shell parsing. */
export function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}
/** Match exact mountpoint records, never directory contents or device names. */
export function mountinfoContains(contents: string, mountPath: string): boolean {
  return contents.split('\n').some(line => {
    const separator = line.indexOf(' - ')
    if (separator < 0) return false
    const before = line.slice(0, separator).split(' ')
    const after = line.slice(separator + 3).split(' ')
    return before[4] !== undefined && decodeMountPath(before[4]) === mountPath && /^(fuse\.sshfs|fusefs|osxfuse|macfuse)$/u.test(after[0] ?? '')
  })
}

/** Manages registered mounts; unmounted records remain available to routing's fail-closed check. */
export class SshWorkspaceManager {
  readonly ready: Promise<void>
  private readonly options: Required<ManagerOptions>
  private readonly servers = new Map<string, ServerView>()
  private readonly workspaces = new Map<string, WorkspaceView>()
  private readonly retiredMounts = new Map<string, WorkspaceRecord>()
  private readonly remotes = new Map<string, Remote>()
  private readonly mounts = new Map<string, RuntimeMount>()
  private readonly connectJobs = new Map<string, Promise<ManagerState>>()
  private tail: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly ctx: Context, options: ManagerOptions) {
    if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('SSH workspaces require a Linux/macOS host; use WSL2 on Windows')
    for (const field of ['stateDir', 'mountRoot'] as const) if (!isAbsolute(options[field])) throw new Error(`${field} must be an absolute host path`)
    this.options = {
      stateDir: resolve(options.stateDir), mountRoot: resolve(options.mountRoot),
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      mountTimeoutMs: options.mountTimeoutMs ?? 20_000,
      sshfsBinary: options.sshfsBinary ?? 'sshfs',
      helperInstallTimeoutMs: options.helperInstallTimeoutMs ?? 600_000,
    }
    if (this.options.stateDir === '/' || this.options.mountRoot === '/') throw new Error('State and mounts require dedicated directories')
    this.ready = this.initialize()
  }

  /** Browser projection; errors never include credential file contents. */
  state(): ManagerState {
    return { servers: [...this.servers.values()].map(value => structuredClone(value)), workspaces: [...this.workspaces.values()].map(value => structuredClone(value)) }
  }

  configHosts() { return discoverConfigHosts() }

  /** Start a durable-in-process operation; a browser refresh must not cancel deployment. */
  beginConnect(id: string): ManagerState {
    const server = this.requireServer(id)
    if (this.disposed) throw new Error('SSH workspace plugin is stopping')
    if (this.connectJobs.has(id) || server.status === 'connected') return this.state()
    server.status = 'connecting'
    delete server.error
    const job = this.connect(id)
    this.connectJobs.set(id, job)
    void job.catch(error => { server.status = 'error'; server.error = message(error) })
      .finally(() => this.connectJobs.delete(id))
    return this.state()
  }

  /** Includes offline records so a stale conversation can never fall through to local execution. */
  listMounts(): Array<{ serverId: string; host?: string; localPath: string; remotePath: string; executableMap: Record<string, string>; hostExecutables: string[]; status: MountStatus }> {
    const live = [...this.workspaces.values()].map(workspace => ({
      serverId: workspace.serverId, host: this.requireServer(workspace.serverId).host, localPath: workspace.mountPath, remotePath: workspace.remotePath,
      executableMap: this.requireServer(workspace.serverId).executableMap, hostExecutables: this.requireServer(workspace.serverId).hostExecutables, status: workspace.status,
    }))
    const retired = [...this.retiredMounts.values()].map(workspace => ({
      serverId: workspace.serverId, localPath: workspace.mountPath, remotePath: workspace.remotePath,
      executableMap: {}, hostExecutables: [], status: 'unmounted' as const,
    }))
    return [...live, ...retired]
  }

  /** Returns a provider only after the helper and all requested tunnels are ready. */
  getRemote(serverId: string): RemoteProviders | undefined {
    return this.servers.get(serverId)?.status === 'connected' ? this.remotes.get(serverId) : undefined
  }

  upsertServer(input: unknown): Promise<ManagerState> {
    return this.enqueue(async () => {
      const parsed = serverInput.parse(input)
      const id = parsed.id ?? randomUUID()
      if (parsed.id !== undefined && !this.servers.has(id)) throw new Error('Unknown SSH server')
      if (this.connectJobs.has(id) || this.remotes.has(id) || this.hasMounted(id)) throw new Error('Disconnect this server before editing its connection settings')
      const previous = this.servers.get(id)
      const helperMode = parsed.helperMode ?? (parsed.helper ? 'manual' : 'auto')
      const reusable = helperMode === 'auto' && previous?.helperMode === 'auto' && previous.host === parsed.host
        ? { helper: previous.helper, helperHash: previous.helperHash, launch: previous.launch } : {}
      this.servers.set(id, { ...parsed, ...reusable, helperMode, id, status: 'disconnected' })
      try { await this.save() } catch (error) { if (previous) this.servers.set(id, previous); else this.servers.delete(id); throw error }
      return this.state()
    })
  }

  removeServer(id: string): Promise<ManagerState> {
    return this.enqueue(async () => {
      const server = this.requireServer(id)
      if (this.connectJobs.has(id)) throw new Error('Wait for helper installation/connection to finish')
      if ([...this.workspaces.values()].some(workspace => workspace.serverId === id)) throw new Error('Remove this server’s SSH workspace registrations first')
      await this.disconnectInternal(id)
      this.servers.delete(id)
      try { await this.save() } catch (error) { this.servers.set(id, server); throw error }
      return this.state()
    })
  }

  connect(id: string): Promise<ManagerState> {
    return this.enqueue(async () => { await this.connectInternal(id); return this.state() })
  }

  disconnect(id: string): Promise<ManagerState> {
    return this.enqueue(async () => {
      this.requireServer(id)
      const owned = [...this.workspaces.values()].filter(workspace => workspace.serverId === id)
      for (const workspace of owned) await this.assertInactive(workspace)
      for (const workspace of owned) await this.unmountInternal(workspace)
      await this.disconnectInternal(id)
      return this.state()
    })
  }

  addWorkspace(input: unknown): Promise<ManagerState> {
    return this.enqueue(async () => {
      const parsed = workspaceInput.parse(input)
      this.requireServer(parsed.serverId)
      const remote = await this.connectInternal(parsed.serverId)
      const target = await remote.fs.resolve(parsed.remotePath)
      if ((await remote.fs.stat(target))?.type !== 'directory') throw new Error('The remote workspace must be an existing directory')
      const remotePath = remote.fs.processPath(target)
      await this.assertRuntimeOutside(parsed.serverId, remotePath, remote)
      const duplicate = [...this.workspaces.values()].find(workspace => workspace.serverId === parsed.serverId && workspace.remotePath === remotePath)
      if (duplicate) { await this.mountInternal(duplicate); return this.state() }
      const id = randomUUID()
      const workspace: WorkspaceView = { ...parsed, id, remotePath, mountPath: join(this.options.mountRoot, id), status: 'unmounted' }
      this.workspaces.set(id, workspace)
      try { await this.save() } catch (error) { this.workspaces.delete(id); throw error }
      await this.mountInternal(workspace)
      return this.state()
    })
  }

  mountWorkspace(id: string): Promise<ManagerState> {
    return this.enqueue(async () => { await this.mountInternal(this.requireWorkspace(id)); return this.state() })
  }

  unmountWorkspace(id: string): Promise<ManagerState> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(id)
      await this.assertInactive(workspace)
      await this.unmountInternal(workspace)
      return this.state()
    })
  }

  removeWorkspace(id: string): Promise<ManagerState> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(id)
      await this.assertInactive(workspace)
      await this.unmountInternal(workspace)
      if (workspace.workspaceId !== undefined) await this.ctx.workspaceRegistry.delete(WorkspaceId(workspace.workspaceId))
      this.workspaces.delete(id)
      const { status: _status, error: _error, ...retired } = workspace
      this.retiredMounts.set(id, retired)
      try { await this.save() }
      catch (error) { this.retiredMounts.delete(id); this.workspaces.set(id, workspace); throw error }
      // Saved conversations retain this cwd indefinitely: keep its route and offline marker.
      return this.state()
    })
  }

  probe(id: string): Promise<{ ok: boolean; message: string; sandboxChecks: SandboxChecks }> {
    return this.enqueue(async () => {
      const remote = await this.connectInternal(id)
      const hello = await remote.ssh.ready
      const rg = await remote.subprocess.resolveExecutable('rg').catch(() => undefined)
      const server = this.requireServer(id)
      const sandboxChecks = await this.checkSandboxes(server, remote)
      server.sandboxChecks = sandboxChecks
      const failures = Object.entries(sandboxChecks).filter(([, check]) => check.status !== 'selected')
      return { ok: failures.length === 0, sandboxChecks,
        message: `${hello.platform}; Node ${hello.nodeVersion}; helper SHA-256 verified; ${rg ? `ripgrep: ${rg}` : 'ripgrep unavailable: install rg remotely for grep/glob'}`
          + (failures.length ? `; SSH connected, sandbox preflight failed: ${failures.map(([location]) => location).join(', ')}. See the server card for details.` : '; sandbox backend selection succeeded (runtime checks still apply)') }
    })
  }

  private async checkSandboxes(server: ServerView, remote: Remote): Promise<SandboxChecks> {
    const [host, target] = await Promise.all([
      checkSandbox(this.ctx.sandbox, this.options.stateDir, 'DSH Host'),
      // Read-only: '/' is never granted workspace-write by a diagnostic.
      checkSandbox(remote.sandbox, '/', `SSH server ${server.host}`),
    ])
    return { host, remote: target }
  }

  /** Teardown does not replay any interrupted operation. Sessions remain durable in DSH. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.ready.catch(() => {})
    await this.tail
    const errors: unknown[] = []
    for (const workspace of this.workspaces.values()) {
      try { await this.unmountInternal(workspace) } catch (error) { errors.push(error) }
    }
    for (const id of [...this.remotes.keys()]) {
      try { await this.disconnectInternal(id) } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Some SSH resources could not be released; inspect mount state before restarting')
  }

  private async initialize(): Promise<void> {
    for (const directory of [this.options.stateDir, this.options.mountRoot]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (await realpath(directory) !== directory) throw new Error('stateDir and mountRoot must be canonical directories, without symlink components')
      await chmod(directory, 0o700)
    }
    let contents: string
    try { contents = await readFile(join(this.options.stateDir, 'state.json'), 'utf8') }
    catch (error) { if (missing(error)) return; throw error }
    const state = persistedState.parse(JSON.parse(contents))
    for (const server of state.servers) this.servers.set(server.id, { ...server, helperMode: server.helperMode ?? (server.helper ? 'manual' : 'auto'), status: 'disconnected' })
    for (const workspace of state.workspaces) {
      if (workspace.mountPath !== join(this.options.mountRoot, workspace.id)) throw new Error('Stored mount path is outside the configured mount root')
      const view: WorkspaceView = { ...workspace, status: 'unmounted' }
      this.workspaces.set(workspace.id, view)
      if (await this.isMounted(workspace.mountPath)) {
        view.status = 'error'
        view.error = 'An existing mount was found after restart. Unmount it explicitly, then reconnect; no existing transport was adopted.'
      } else await this.offlineMarker(workspace.mountPath)
    }
    for (const retired of state.retiredMounts) {
      if (retired.mountPath !== join(this.options.mountRoot, retired.id)) throw new Error('Stored retired mount path is outside the configured mount root')
      this.retiredMounts.set(retired.id, retired)
      // Never adopt or tear down an unrelated mount; its route remains blocked either way.
      if (!(await this.isMounted(retired.mountPath))) await this.offlineMarker(retired.mountPath)
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      await this.ready
      if (this.disposed) throw new Error('SSH workspace plugin is stopping')
      return operation()
    })
    this.tail = pending.then(() => {}, () => {})
    return pending
  }

  private async save(): Promise<void> {
    const data = {
      version: 1,
      servers: [...this.servers.values()].map(({ status: _status, error: _error, setupPhase: _phase, sandboxChecks: _checks, ...server }) => server),
      workspaces: [...this.workspaces.values()].map(({ status: _status, error: _error, ...workspace }) => workspace),
      retiredMounts: [...this.retiredMounts.values()],
    }
    const temporary = join(this.options.stateDir, `.state-${randomUUID()}.json`)
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(data, null, 2)}\n`); await file.sync() }
    finally { await file.close() }
    try {
      await rename(temporary, join(this.options.stateDir, 'state.json'))
      const directory = await open(this.options.stateDir, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) { await unlink(temporary).catch(() => {}); throw error }
  }

  private requireServer(id: string): ServerView {
    const server = this.servers.get(id)
    if (!server) throw new Error('Unknown SSH server')
    return server
  }

  private requireWorkspace(id: string): WorkspaceView {
    const workspace = this.workspaces.get(id)
    if (!workspace) throw new Error('Unknown SSH workspace')
    return workspace
  }

  private hasMounted(serverId: string): boolean {
    return [...this.workspaces.values()].some(workspace => workspace.serverId === serverId && (workspace.status === 'mounted' || workspace.status === 'mounting'))
  }

  private async connectInternal(id: string): Promise<Remote> {
    const server = this.requireServer(id)
    const existing = this.remotes.get(id)
    if (existing && server.status === 'connected') return existing
    if (existing) await this.disconnectInternal(id)
    server.status = 'connecting'
    delete server.error
    delete server.sandboxChecks
    let remote: Remote | undefined
    let fiber: Fiber | undefined
    try {
      if (server.helperMode === 'auto' || (!server.helperMode && !server.helper)) {
        server.status = 'installing'
        const deployment = await ensureHelper(server.host, this.options.stateDir, this.options.helperInstallTimeoutMs, phase => { server.setupPhase = phase }, server.helper)
        Object.assign(server, deployment, { helperMode: 'auto' })
        await this.save()
      }
      server.status = 'connecting'
      delete server.setupPhase
      const { helper, helperHash, launch } = server
      if (!helper || !helperHash || !launch) throw new Error('SSH helper configuration is incomplete')
      const scoped = this.ctx.isolate('ssh').isolate('subprocess').isolate('sandbox').isolate('fs')
      fiber = scoped.plugin(async child => {
        const ssh = new SshConnection(child, {
          host: server.host, helper, helperHash, launch,
          workspace: '/', requestTimeoutMs: this.options.requestTimeoutMs,
          maxFrameBytes: 64 * 1024 * 1024, maxPending: 128, leaseMs: 30_000,
        })
        await ssh.ready
        remote = { ssh, subprocess: new SshSubprocessRuntime(child), sandbox: new SshSandboxProvider(child), fs: new SshFileSystem(child), fiber: child.fiber }
      })
      await fiber
      if (remote === undefined) throw new Error('SSH helper failed to initialize; check its version, digest, and OpenSSH alias')
      if (server.tunnels.length > 0) remote.tunnel = await this.startTunnels(server)
      // A missing sandbox is a tool capability failure, not an SSH disconnect.
      server.sandboxChecks = await this.checkSandboxes(server, remote)
      this.remotes.set(id, remote)
      server.status = 'connected'
      const connected = remote
      let checking = false
      // SshConnection owns the lease heartbeat. The wire protocol allows only
      // ONE pending heartbeat, independent of maxPending: sending another here
      // races its native timer and can invalidate an otherwise healthy server.
      // Use a cheap read-only provider query for UI status, with one in flight.
      remote.healthCheck = setInterval(() => {
        if (checking || this.remotes.get(id) !== connected || server.status !== 'connected') return
        checking = true
        void connected.subprocess.terminalEnvironment().catch((error: unknown) => {
          if (this.remotes.get(id) !== connected) return
          // Ordinary-request backpressure is not transport failure. The native
          // heartbeat has reserved capacity and continues renewing the lease.
          if (message(error) === 'SSH helper pending request limit reached') return
          server.status = 'error'
          server.error = message(error)
          if (connected.healthCheck) clearInterval(connected.healthCheck)
        }).finally(() => { checking = false })
      }, 10_000)
      remote.healthCheck.unref()
      return remote
    } catch (error) {
      server.status = 'error'
      server.error = message(error)
      delete server.setupPhase
      await fiber?.dispose().catch(() => {})
      throw error
    }
  }

  private async disconnectInternal(id: string): Promise<void> {
    const server = this.requireServer(id)
    const remote = this.remotes.get(id)
    this.remotes.delete(id)
    server.status = 'disconnected'
    delete server.error
    delete server.setupPhase
    delete server.sandboxChecks
    if (!remote) return
    if (remote.healthCheck) clearInterval(remote.healthCheck)
    if (remote.tunnel) await this.stopChild(remote.tunnel)
    await remote.fiber.dispose()
  }

  private async assertRuntimeOutside(serverId: string, workspacePath: string, remote: Remote): Promise<void> {
    const server = this.requireServer(serverId)
    if (!server.helper || !server.launch) throw new Error('SSH helper is not installed')
    const runtimePaths = [server.helper]
    if (server.launch.kind === 'node-script') {
      runtimePaths.push(server.launch.node)
      if (server.launch.bootstrapPath !== undefined) runtimePaths.push(server.launch.bootstrapPath)
    }
    for (const path of runtimePaths) {
      const target = await remote.fs.resolve(path)
      const canonical = remote.fs.processPath(target)
      if (workspacePath === '/' || canonical === workspacePath || canonical.startsWith(`${workspacePath}/`)) {
        throw new Error('Keep the SSH helper and its Node runtime outside writable workspaces')
      }
    }
  }

  private async assertInactive(workspace: WorkspaceView): Promise<void> {
    if (workspace.workspaceId === undefined) return
    const native = this.ctx.workspaceRegistry.get(WorkspaceId(workspace.workspaceId))
    for (const sessionId of native?.sessionIds ?? []) {
      const activities = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      if (activities.length > 0) throw new Error('Stop active conversations, jobs, subagents, and schedules before unmounting this workspace')
    }
  }

  private async mountInternal(workspace: WorkspaceView): Promise<void> {
    if (workspace.status === 'mounted' && this.mounts.has(workspace.id)) { await this.connectInternal(workspace.serverId); return }
    if (await this.isMounted(workspace.mountPath)) throw new Error('Mountpoint is already occupied. Unmount it explicitly before retrying.')
    const remote = await this.connectInternal(workspace.serverId)
    const target = await remote.fs.resolve(workspace.remotePath)
    if ((await remote.fs.stat(target))?.type !== 'directory') throw new Error('Remote directory no longer exists')
    const canonical = remote.fs.processPath(target)
    await this.assertRuntimeOutside(workspace.serverId, canonical, remote)
    if (canonical !== workspace.remotePath) throw new Error('Remote directory now resolves to a different location; recreate its workspace registration')
    workspace.status = 'mounting'
    delete workspace.error
    await this.removeOfflineMarker(workspace.mountPath)
    await mkdir(workspace.mountPath, { mode: 0o700 })
    const server = this.requireServer(workspace.serverId)
    const args = sshfsArguments(server.host, workspace.remotePath, workspace.mountPath)
    const child = spawn(this.options.sshfsBinary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    let spawnError: Error | undefined
    child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-3000) })
    child.once('error', error => { spawnError = error })
    const closed = new Promise<void>(done => { child.once('close', () => {
      if (workspace.status === 'mounted' || workspace.status === 'mounting') {
        workspace.status = 'error'
        workspace.error = 'SSHFS disconnected; reconnect explicitly. No command was replayed.'
        void this.isMounted(workspace.mountPath).then(async mounted => {
          if (!mounted) await this.offlineMarker(workspace.mountPath)
        }).catch((error: unknown) => { workspace.error = `SSHFS disconnected; offline marker failed: ${message(error)}` })
      }
      this.mounts.delete(workspace.id)
      done()
    }) })
    this.mounts.set(workspace.id, { process: child, closed })
    try {
      const deadline = Date.now() + this.options.mountTimeoutMs
      while (!(await this.isMounted(workspace.mountPath))) {
        if (spawnError) throw spawnError
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`SSHFS failed: ${diagnostic || 'process exited'}`)
        if (Date.now() >= deadline) throw new Error(`SSHFS mount timed out: ${diagnostic}`)
        await wait(100)
      }
      const native = await this.ctx.workspaceRegistry.create(workspace.mountPath, workspace.title)
      workspace.workspaceId = native.id
      workspace.status = 'mounted'
      await this.save()
    } catch (error) {
      workspace.status = 'error'
      workspace.error = message(error)
      try { await this.unmountPhysical(workspace) } catch (cleanupError) { workspace.error += `; cleanup: ${message(cleanupError)}` }
      throw error
    }
  }

  private async unmountInternal(workspace: WorkspaceView): Promise<void> {
    const oldStatus = workspace.status
    workspace.status = 'unmounted'
    try {
      await this.unmountPhysical(workspace)
      delete workspace.error
    } catch (error) {
      workspace.status = 'error'
      workspace.error = `Unmount failed (${oldStatus}): ${message(error)}`
      throw error
    }
  }

  private async unmountPhysical(workspace: WorkspaceView): Promise<void> {
    if (await this.isMounted(workspace.mountPath)) {
      if (process.platform === 'darwin') await run('umount', [workspace.mountPath], { timeout: this.options.requestTimeoutMs })
      else {
        try { await run('fusermount3', ['-u', workspace.mountPath], { timeout: this.options.requestTimeoutMs }) }
        catch (error) {
          if (!missing(error)) throw error
          await run('fusermount', ['-u', workspace.mountPath], { timeout: this.options.requestTimeoutMs })
        }
      }
      if (await this.isMounted(workspace.mountPath)) throw new Error('Filesystem remains mounted')
    }
    const running = this.mounts.get(workspace.id)
    if (running) {
      running.process.kill('SIGTERM')
      await Promise.race([running.closed, wait(1000)])
      if (running.process.exitCode === null && running.process.signalCode === null) running.process.kill('SIGKILL')
      await running.closed
      this.mounts.delete(workspace.id)
    }
    await this.offlineMarker(workspace.mountPath)
  }

  private async isMounted(path: string): Promise<boolean> {
    if (process.platform === 'linux') return mountinfoContains(await readFile('/proc/self/mountinfo', 'utf8'), path)
    const { stdout } = await run('mount', [], { timeout: this.options.requestTimeoutMs })
    return stdout.split('\n').some(line => line.includes(` on ${path} (`) && /(?:sshfs|macfuse|osxfuse|fusefs)/u.test(line))
  }

  private async offlineMarker(path: string): Promise<void> {
    const rel = relative(this.options.mountRoot, path)
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel) || rel.includes(sep)) throw new Error('Invalid mountpoint')
    let info
    try { info = await lstat(path) } catch (error) { if (!missing(error)) throw error }
    if (info?.isSymbolicLink()) {
      const expected = join(this.options.stateDir, 'offline-not-mounted', rel, 'workspace')
      if (await readlink(path) !== expected) throw new Error('Offline mount marker has been changed')
      return
    }
    if (info && !info.isDirectory()) throw new Error('Mountpoint has been replaced by a non-directory')
    if (info) await rmdir(path) // Never recursively delete user content.
    await symlink(join(this.options.stateDir, 'offline-not-mounted', rel, 'workspace'), path)
  }

  private async removeOfflineMarker(path: string): Promise<void> {
    let info
    try { info = await lstat(path) } catch (error) { if (missing(error)) return; throw error }
    if (info.isSymbolicLink()) await unlink(path)
    else if (info.isDirectory()) await rmdir(path) // Empty owned mountpoint only.
    else throw new Error('Refusing to replace a non-directory mountpoint')
  }

  private async startTunnels(server: ServerRecord): Promise<ChildProcess> {
    const controlPath = join(this.options.stateDir, `t-${server.id.slice(0, 12)}`)
    if (Buffer.byteLength(controlPath) > 90) throw new Error('stateDir path is too long for an SSH control socket')
    const forwards = server.tunnels.flatMap(tunnel => ['-R', `127.0.0.1:${tunnel.remotePort}:${tunnel.host === '::1' ? '[::1]' : tunnel.host}:${tunnel.port}`])
    const child = spawn('ssh', ['-NT', '-M', '-S', controlPath,
      '-o', 'ControlPersist=no', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ExitOnForwardFailure=yes', '-o', 'GatewayPorts=no', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
      ...forwards, server.host,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostic = ''
    let launchError: Error | undefined
    child.stderr?.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-3000) })
    child.once('error', error => { launchError = error })
    try {
      const deadline = Date.now() + this.options.requestTimeoutMs
      while (Date.now() < deadline) {
        if (launchError) throw launchError
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`SSH reverse tunnel failed: ${diagnostic}`)
        try {
          await run('ssh', ['-S', controlPath, '-O', 'check', server.host], { timeout: 2000 })
          child.once('close', () => {
            const state = this.servers.get(server.id)
            if (state?.status === 'connected' && this.remotes.get(server.id)?.tunnel === child) { state.status = 'error'; state.error = 'SSH reverse tunnel disconnected; reconnect explicitly' }
          })
          return child
        } catch { await wait(100) }
      }
      throw new Error(`SSH reverse tunnel timed out: ${diagnostic}`)
    } catch (error) { await this.stopChild(child); throw error }
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
    const closed = new Promise<void>(done => { child.once('close', () => { done() }) })
    child.kill('SIGTERM')
    await Promise.race([closed, wait(1000)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await closed
  }
}

