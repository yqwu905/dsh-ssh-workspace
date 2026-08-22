import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessCollect,
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ClientChannel } from 'ssh2'
import type { SshServerRuntime } from './index.js'
import { TailOutputReader } from './output.js'
import { buildRemoteCommand, quoteShell, waitForAbort } from './ssh-utils.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return typeof mode === 'object'
}

function toNodeSignal(signal: string | null | undefined): NodeJS.Signals | null {
  if (signal === undefined || signal === null || signal.length === 0) return null
  return (signal.startsWith('SIG') ? signal : `SIG${signal}`) as NodeJS.Signals
}

function sshSignal(signal: SubprocessTerminalSignal | NodeJS.Signals): string {
  return signal.startsWith('SIG') ? signal.slice(3) : signal
}

type RemoteKillTarget = { readonly kind: 'group' | 'process'; readonly pid: number }

/** Launch behind a waiter so the SSH channel stays open while the command owns a killable session. */
function managedRemoteArgv(argv: readonly string[], token: string): readonly string[] {
  const marker = (kind: RemoteKillTarget['kind']): string =>
    `printf '\\036dsh-ssh-process:${token}:${kind}:%s\\037' "$$" >&2; exec "$@"`
  const script = [
    'exec 3<&0',
    'if command -v setsid >/dev/null 2>&1; then',
    `  setsid /bin/sh -c ${quoteShell(marker('group'))} dsh-ssh-workspace "$@" <&3 &`,
    'else',
    `  /bin/sh -c ${quoteShell(marker('process'))} dsh-ssh-workspace "$@" <&3 &`,
    'fi',
    'dsh_ssh_pid=$!',
    'exec 3<&-',
    'wait "$dsh_ssh_pid"',
  ].join('\n')
  return ['/bin/sh', '-c', script, 'dsh-ssh-workspace', ...argv]
}

function terminalControlCharacter(signal: SubprocessTerminalSignal): string | undefined {
  // SSH signal requests target the server-side shell, not necessarily the PTY foreground group.
  // The terminal line discipline turns these control bytes into foreground-group signals.
  if (signal === 'SIGINT') return '\x03'
  if (signal === 'SIGTSTP') return '\x1a'
  return undefined
}

interface OutputSink {
  readonly pipe: PassThrough | undefined
  readonly reader: TailOutputReader | undefined
  write(chunk: Buffer | string): void
  end(): void
  fail(error: Error): void
}

function outputSink(mode: SubprocessOutputMode, inherited: NodeJS.WriteStream): OutputSink {
  const pipe = mode === 'pipe' ? new PassThrough() : undefined
  const reader = isCollect(mode) ? new TailOutputReader(mode.maxBytes) : undefined
  return {
    pipe,
    reader,
    write(chunk) {
      if (pipe !== undefined) pipe.write(chunk)
      else if (reader !== undefined) reader.push(chunk)
      else inherited.write(chunk)
    },
    end() { pipe?.end() },
    fail(_error) { pipe?.destroy() },
  }
}

class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly completion = deferred<SubprocessOutcome>()
  private readonly stdoutSink: OutputSink
  private readonly stderrSink: OutputSink
  private readonly input: PassThrough | undefined
  private readonly processToken = randomUUID()
  private readonly markerPrefix: Buffer
  private markerBuffer = Buffer.alloc(0)
  private markerRead = false
  private remoteTarget: RemoteKillTarget | undefined
  private channel: ClientChannel | undefined
  private settled = false
  private terminating = false
  private terminationStarted = false
  private killTimer: NodeJS.Timeout | undefined
  private readonly onAbort: (() => void) | undefined

  constructor(
    private readonly server: SshServerRuntime,
    private readonly spec: SubprocessSpawnSpec,
    remoteCwd: string,
  ) {
    this.markerPrefix = Buffer.from(`\x1edsh-ssh-process:${this.processToken}:`, 'utf8')
    this.stdoutSink = outputSink(spec.stdio.stdout, process.stdout)
    this.stderrSink = outputSink(spec.stdio.stderr, process.stderr)
    this.stdout = this.stdoutSink.pipe
    this.stderr = this.stderrSink.pipe
    this.input = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined
    this.stdin = this.input
    this.collected = {
      ...(this.stdoutSink.reader !== undefined ? { stdout: this.stdoutSink.reader } : {}),
      ...(this.stderrSink.reader !== undefined ? { stderr: this.stderrSink.reader } : {}),
    }
    this.done = this.completion.promise
    this.onAbort = spec.signal === undefined ? undefined : () => this.terminate()
    if (this.onAbort !== undefined) spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    if (spec.signal?.aborted === true) this.terminate()
    void this.start(remoteCwd)
  }

  get pid(): number {
    return this.remoteTarget?.pid ?? -1
  }

  terminate(): void {
    if (this.settled || this.terminating) return
    this.terminating = true
    this.startTerminationIfReady()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) return await this.done.then(() => true, () => true)
    return await Promise.race([this.done.then(() => true, () => true), waitForAbort(signal)])
  }

  private async start(remoteCwd: string): Promise<void> {
    try {
      const canonicalCwd = await this.server.requireRemoteDirectory(remoteCwd)
      const client = await this.server.getClient()
      if (this.settled) return
      const argv = await this.server.adaptArgv(this.spec.argv, this.spec.signal)
      const command = buildRemoteCommand(managedRemoteArgv(argv, this.processToken), canonicalCwd, this.spec.env)
      client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
        if (error !== undefined) {
          this.fail(error)
          return
        }
        this.channel = channel
        channel.on('data', (chunk: Buffer | string) => this.stdoutSink.write(chunk))
        channel.stderr.on('data', (chunk: Buffer | string) => this.consumeStderr(chunk))
        channel.once('error', (error: Error) => this.fail(error))
        channel.once('close', (code: number | null, signal: string | null) => {
          this.finish({ exitCode: code ?? null, signal: toNodeSignal(signal) })
        })
        if (this.input !== undefined) this.input.pipe(channel)
        else if (typeof this.spec.stdio.stdin === 'object') channel.end(this.spec.stdio.stdin.data)
        else channel.end()
      })
    } catch (error: unknown) {
      this.fail(error)
    }
  }

  private startTerminationIfReady(): void {
    const channel = this.channel
    const target = this.remoteTarget
    if (!this.terminating || this.terminationStarted || channel === undefined || target === undefined) return
    this.terminationStarted = true
    void this.signalRemote(target, 'TERM')
    this.killTimer = setTimeout(() => {
      void this.signalRemote(target, 'KILL').finally(() => channel.close())
    }, this.spec.graceMs)
    this.killTimer.unref()
  }

  private async signalRemote(target: RemoteKillTarget, signal: 'TERM' | 'KILL'): Promise<void> {
    const operand = target.kind === 'group' ? `-${target.pid}` : String(target.pid)
    try {
      await this.server.execControl(`kill -${signal} ${operand}`, undefined, 16_384)
    } catch {
      if (target.kind === 'process') {
        try { this.channel?.signal(signal) } catch {}
      }
    }
  }

  private consumeStderr(chunk: Buffer | string): void {
    if (this.markerRead) {
      this.stderrSink.write(chunk)
      return
    }
    this.markerBuffer = Buffer.concat([this.markerBuffer, Buffer.from(chunk)])
    const prefixAt = this.markerBuffer.indexOf(this.markerPrefix)
    if (prefixAt < 0) {
      const retained = Math.min(this.markerBuffer.length, this.markerPrefix.length - 1)
      const writable = this.markerBuffer.subarray(0, this.markerBuffer.length - retained)
      if (writable.length > 0) this.stderrSink.write(writable)
      this.markerBuffer = this.markerBuffer.subarray(this.markerBuffer.length - retained)
      return
    }
    const markerEnd = this.markerBuffer.indexOf(0x1f, prefixAt + this.markerPrefix.length)
    if (markerEnd < 0) return
    if (prefixAt > 0) this.stderrSink.write(this.markerBuffer.subarray(0, prefixAt))
    const body = this.markerBuffer.subarray(prefixAt + this.markerPrefix.length, markerEnd).toString('utf8')
    const match = /^(group|process):([1-9][0-9]*)$/u.exec(body)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const pid = Number(match[2])
      if (Number.isSafeInteger(pid)) this.remoteTarget = { kind: match[1] as RemoteKillTarget['kind'], pid }
    }
    this.markerRead = true
    const remaining = this.markerBuffer.subarray(markerEnd + 1)
    this.markerBuffer = Buffer.alloc(0)
    if (remaining.length > 0) this.stderrSink.write(remaining)
    this.startTerminationIfReady()
  }

  private flushMarkerBuffer(): void {
    if (this.markerBuffer.length > 0) this.stderrSink.write(this.markerBuffer)
    this.markerBuffer = Buffer.alloc(0)
  }

  private finish(outcome: SubprocessOutcome): void {
    if (this.settled) return
    this.settled = true
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    if (this.onAbort !== undefined) this.spec.signal?.removeEventListener('abort', this.onAbort)
    this.input?.destroy()
    this.flushMarkerBuffer()
    this.stdoutSink.end()
    this.stderrSink.end()
    this.completion.resolve(outcome)
  }

  private fail(reason: unknown): void {
    if (this.settled) return
    this.settled = true
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    if (this.onAbort !== undefined) this.spec.signal?.removeEventListener('abort', this.onAbort)
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.input?.destroy(error)
    this.flushMarkerBuffer()
    this.stdoutSink.fail(error)
    this.stderrSink.fail(error)
    this.completion.reject(error)
  }
}

class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly pid = -1
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private readonly completion = deferred<SubprocessOutcome>()
  private readonly ready = deferred<ClientChannel>()
  private channel: ClientChannel | undefined
  private terminated = false
  private settled = false
  private readonly onAbort: (() => void) | undefined

  constructor(
    private readonly server: SshServerRuntime,
    private readonly spec: SubprocessTerminalSpawnSpec,
    remoteCwd: string,
  ) {
    this.done = this.completion.promise
    this.onAbort = spec.signal === undefined ? undefined : () => { void this.terminate() }
    if (this.onAbort !== undefined) spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    if (spec.signal?.aborted === true) void this.terminate()
    void this.start(remoteCwd)
  }

  async write(data: string): Promise<void> {
    if (this.terminated) throw new Error('dsh-ssh-workspace: terminal is terminating')
    const channel = await this.ready.promise
    await new Promise<void>((resolveWrite, reject) => {
      channel.write(data, (error?: Error | null) => error == null ? resolveWrite() : reject(error))
    })
  }

  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return undefined
  }

  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    if (this.terminated) throw new Error('dsh-ssh-workspace: terminal is terminating')
    const channel = await this.ready.promise
    const control = terminalControlCharacter(signal)
    if (control !== undefined) {
      await new Promise<void>((resolveWrite, reject) => {
        channel.write(control, (error?: Error | null) => error == null ? resolveWrite() : reject(error))
      })
    } else {
      channel.signal(sshSignal(signal))
    }
    return -1
  }

  async terminate(): Promise<void> {
    if (this.terminated) return await this.done.then(() => {}, () => {})
    this.terminated = true
    let channel: ClientChannel
    try {
      channel = await this.ready.promise
    } catch {
      return
    }
    try {
      channel.signal('TERM')
    } catch {
      channel.close()
    }
    const timer = setTimeout(() => {
      try { channel.signal('KILL') } catch {}
      channel.close()
    }, this.spec.graceMs)
    timer.unref()
    await this.done.then(() => {}, () => {})
    clearTimeout(timer)
  }

  private async start(remoteCwd: string): Promise<void> {
    try {
      this.spec.signal?.throwIfAborted()
      const canonicalCwd = await this.server.requireRemoteDirectory(remoteCwd)
      this.spec.signal?.throwIfAborted()
      const client = await this.server.getClient()
      this.spec.signal?.throwIfAborted()
      const argv = await this.server.adaptArgv(this.spec.argv, this.spec.signal)
      const command = buildRemoteCommand(argv, canonicalCwd, this.spec.env)
      client.exec(command, {
        pty: {
          term: 'xterm-256color',
          rows: this.spec.rows,
          cols: this.spec.cols,
          width: 0,
          height: 0,
        },
      }, (error: Error | undefined, channel: ClientChannel) => {
        if (error !== undefined) {
          this.fail(error)
          return
        }
        this.channel = channel
        channel.on('data', (chunk: Buffer | string) => this.output.write(chunk))
        channel.once('error', (error: Error) => this.fail(error))
        channel.once('close', (code: number | null, signal: string | null) => {
          this.finish({ exitCode: code ?? null, signal: toNodeSignal(signal) })
        })
        this.ready.resolve(channel)
        if (this.terminated) void this.terminate()
      })
    } catch (error: unknown) {
      this.fail(error)
    }
  }

  private fail(reason: unknown): void {
    if (this.settled) return
    this.settled = true
    if (this.onAbort !== undefined) this.spec.signal?.removeEventListener('abort', this.onAbort)
    const error = reason instanceof Error ? reason : new Error(String(reason))
    this.ready.reject(error)
    this.output.destroy()
    this.completion.reject(error)
    this.channel?.close()
  }

  private finish(outcome: SubprocessOutcome): void {
    if (this.settled) return
    this.settled = true
    if (this.onAbort !== undefined) this.spec.signal?.removeEventListener('abort', this.onAbort)
    this.output.end()
    this.completion.resolve(outcome)
  }
}

/** Route SSH anchor working directories remotely and retain native local process execution elsewhere. */
export class SshSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['sshWorkspace']

  private readonly remoteProcesses = new Set<SshSubprocessHandle>()
  private readonly remoteTerminals = new Set<SshTerminalHandle>()
  private disposing = false

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposing = true
      const pending: Promise<unknown>[] = []
      for (const handle of this.remoteProcesses) {
        handle.terminate()
        pending.push(handle.done.catch(() => {}))
      }
      for (const terminal of this.remoteTerminals) pending.push(terminal.terminate())
      await Promise.allSettled(pending)
      this.remoteProcesses.clear()
      this.remoteTerminals.clear()
    }, 'SSH subprocess teardown')
  }

  override async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const routed = this.ctx.sshWorkspace.resolveAnchoredPath(command)
    if (routed === undefined) return await super.resolveExecutable(command, env, signal)
    return await routed.server.resolveExecutable(routed.remotePath, env, signal)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('dsh-ssh-workspace: subprocess service is disposing')
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new Error('dsh-ssh-workspace: argv must contain a non-empty program')
    }
    spec.signal?.throwIfAborted()
    const routed = this.ctx.sshWorkspace.resolveAnchoredPath(spec.cwd)
    if (routed === undefined) return super.spawn(spec)
    const handle = new SshSubprocessHandle(routed.server, spec, routed.remotePath)
    this.remoteProcesses.add(handle)
    void handle.done.then(
      () => this.remoteProcesses.delete(handle),
      () => this.remoteProcesses.delete(handle),
    )
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('dsh-ssh-workspace: subprocess service is disposing')
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new Error('dsh-ssh-workspace: terminal argv must contain a non-empty program')
    }
    spec.signal?.throwIfAborted()
    const routed = this.ctx.sshWorkspace.resolveAnchoredPath(spec.cwd)
    if (routed === undefined) return await super.spawnTerminal(spec)
    const handle = new SshTerminalHandle(routed.server, spec, routed.remotePath)
    this.remoteTerminals.add(handle)
    void handle.done.then(
      () => this.remoteTerminals.delete(handle),
      () => this.remoteTerminals.delete(handle),
    )
    return handle
  }
}

export { TailOutputReader } from './output.js'
export { buildRemoteCommand } from './ssh-utils.js'
export default SshSubprocessRuntime
