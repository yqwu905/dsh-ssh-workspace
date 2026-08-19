import { PassThrough, type Readable, type Writable } from 'node:stream'
import { posix } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  SubprocessRuntime,
} from '@deepseek-ai/dsh-subprocess'
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
import type { ClientChannel } from 'ssh2'
import type {} from './index.js'
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
  readonly pid = -1
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>

  private readonly completion = deferred<SubprocessOutcome>()
  private readonly stdoutSink: OutputSink
  private readonly stderrSink: OutputSink
  private readonly input: PassThrough | undefined
  private channel: ClientChannel | undefined
  private settled = false
  private terminating = false
  private killTimer: NodeJS.Timeout | undefined
  private readonly onAbort: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly spec: SubprocessSpawnSpec,
    remoteCwd: string,
  ) {
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
    void this.start(remoteCwd)
  }

  terminate(): void {
    if (this.settled || this.terminating) return
    this.terminating = true
    const channel = this.channel
    if (channel === undefined) return
    this.sendSignal(channel, 'TERM')
    this.killTimer = setTimeout(() => {
      this.sendSignal(channel, 'KILL')
      channel.close()
    }, this.spec.graceMs)
    this.killTimer.unref()
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) return await this.done.then(() => true, () => true)
    return await Promise.race([this.done.then(() => true, () => true), waitForAbort(signal)])
  }

  private async start(remoteCwd: string): Promise<void> {
    try {
      const canonicalCwd = await this.ctx.sshWorkspace.requireRemoteDirectory(remoteCwd)
      const client = await this.ctx.sshWorkspace.getClient()
      if (this.settled) return
      const command = buildRemoteCommand(this.spec.argv, canonicalCwd, this.spec.env)
      client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
        if (error !== undefined) {
          this.fail(error)
          return
        }
        this.channel = channel
        if (this.terminating) this.terminateReadyChannel(channel)
        channel.on('data', (chunk: Buffer | string) => this.stdoutSink.write(chunk))
        channel.stderr.on('data', (chunk: Buffer | string) => this.stderrSink.write(chunk))
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

  private terminateReadyChannel(channel: ClientChannel): void {
    this.sendSignal(channel, 'TERM')
    this.killTimer = setTimeout(() => {
      this.sendSignal(channel, 'KILL')
      channel.close()
    }, this.spec.graceMs)
    this.killTimer.unref()
  }

  private sendSignal(channel: ClientChannel, signal: string): void {
    try {
      channel.signal(signal)
    } catch {
      channel.close()
    }
  }

  private finish(outcome: SubprocessOutcome): void {
    if (this.settled) return
    this.settled = true
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    if (this.onAbort !== undefined) this.spec.signal?.removeEventListener('abort', this.onAbort)
    this.input?.destroy()
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
    private readonly ctx: Context,
    private readonly spec: SubprocessTerminalSpawnSpec,
    remoteCwd: string,
  ) {
    this.done = this.completion.promise
    this.onAbort = spec.signal === undefined ? undefined : () => { void this.terminate() }
    if (this.onAbort !== undefined) spec.signal?.addEventListener('abort', this.onAbort, { once: true })
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
    channel.signal(sshSignal(signal))
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
      const canonicalCwd = await this.ctx.sshWorkspace.requireRemoteDirectory(remoteCwd)
      this.spec.signal?.throwIfAborted()
      const client = await this.ctx.sshWorkspace.getClient()
      this.spec.signal?.throwIfAborted()
      const command = buildRemoteCommand(this.spec.argv, canonicalCwd, this.spec.env)
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

/** SSH-backed subprocess seam. Existing bash/search/LSP/terminal/subagent consumers stay unchanged. */
export class SshSubprocessRuntime extends SubprocessRuntime {
  static inject = ['sshWorkspace']

  private readonly live = new Set<SshSubprocessHandle>()
  private readonly terminals = new Set<SshTerminalHandle>()
  private disposing = false

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => async () => {
      this.disposing = true
      const pending: Promise<unknown>[] = []
      for (const handle of this.live) {
        handle.terminate()
        pending.push(handle.done.catch(() => {}))
      }
      for (const terminal of this.terminals) pending.push(terminal.terminate())
      await Promise.allSettled(pending)
      this.live.clear()
      this.terminals.clear()
    }, 'SSH subprocess teardown')
  }

  override async resolveExecutable(
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
    const result = await this.ctx.sshWorkspace.execControl(probe, signal, 16_384)
    if (result.exitCode !== 0) {
      throw new Error(`dsh-ssh-workspace: command ${JSON.stringify(command)} was not found on remote PATH`)
    }
    const resolved = result.stdout.trim().split('\n')[0]
    if (resolved === undefined || !posix.isAbsolute(resolved)) {
      throw new Error(`dsh-ssh-workspace: command ${JSON.stringify(command)} did not resolve to an absolute remote path`)
    }
    return resolved
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('dsh-ssh-workspace: subprocess service is disposing')
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new Error('dsh-ssh-workspace: argv must contain a non-empty program')
    }
    spec.signal?.throwIfAborted()
    const remoteCwd = this.ctx.sshWorkspace.paths.toRemote(spec.cwd)
    const handle = new SshSubprocessHandle(this.ctx, spec, remoteCwd)
    this.live.add(handle)
    void handle.done.then(
      () => this.live.delete(handle),
      () => this.live.delete(handle),
    )
    return handle
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.disposing) throw new Error('dsh-ssh-workspace: subprocess service is disposing')
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new Error('dsh-ssh-workspace: terminal argv must contain a non-empty program')
    }
    spec.signal?.throwIfAborted()
    const remoteCwd = this.ctx.sshWorkspace.paths.toRemote(spec.cwd)
    const handle = new SshTerminalHandle(this.ctx, spec, remoteCwd)
    this.terminals.add(handle)
    void handle.done.then(
      () => this.terminals.delete(handle),
      () => this.terminals.delete(handle),
    )
    return handle
  }
}

export { TailOutputReader } from './output.js'
export { buildRemoteCommand } from './ssh-utils.js'
export default SshSubprocessRuntime
