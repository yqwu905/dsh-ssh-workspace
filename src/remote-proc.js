/**
 * Remote processes and terminals for one server.
 *
 * A remote process is a local `ssh` client spawned through the local
 * subprocess provider, so collected output, spill files, `inherit` and raw
 * pipes keep the local provider's exact semantics. The remote side runs the
 * helper's `run` wrapper, which places the program in its own process group,
 * records that group, and kills it when the client disappears (the client
 * keeps the channel's stdin open as a lifeline). Channels are opened one
 * command ahead (helper op `warm`) so the login shell has already started when
 * the command arrives on stdin. Terminals use `ssh -tt` on a
 * local PTY; closing it hangs up the remote session.
 * @module dsh-ssh-fleet/remote-proc
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import { encodeLine, HELPER_HASH } from './ssh.js'

/** Runs the uploaded helper without knowing $HOME on the host side. */
const HELPER_BOOTSTRAP = 'h="$HOME/.cache/dsh-ssh-fleet/helper-' + HELPER_HASH + '.sh"; '
  + '[ -f "$h" ] || { echo "dsh-ssh-fleet: remote helper missing; run /ssh check" >&2; exit 127; }; '
  + 'exec sh "$h" "$@"'

const CONTROL_CHARS = { SIGINT: '\x03', SIGTSTP: '\x1a' }

/** Channels opened ahead of time stay this long, at most this many per server. */
const WARM_IDLE_MS = 120_000
const WARM_MAX = 2

/**
 * Turn an explicit env map into helper entries: `-u NAME` tombstones first,
 * then `NAME=value` assignments.
 * @param {Record<string, string | undefined> | undefined} env
 * @param {Record<string, string>} extra
 * @returns {string[]}
 */
function envEntries(env, extra) {
  const merged = { ...extra, ...env }
  const unset = []
  const set = []
  for (const [key, value] of Object.entries(merged)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (value === undefined) unset.push('-u', key)
    else set.push(`${key}=${value}`)
  }
  return [...unset, ...set]
}

export class RemoteProc {
  /**
   * @param {import('./ssh.js').SshHost} host
   * @param {() => import('@deepseek-ai/dsh-subprocess').SubprocessRuntime} local - local provider (spawns the ssh clients).
   * @param {{ extraEnv: () => Record<string, string>, mapExecutable: (argv0: string) => string, ensureReady: () => void, logger: any }} hooks
   */
  constructor(host, local, hooks) {
    this.host = host
    this.local = local
    this.hooks = hooks
    /**
     * Opened channels waiting for their command, by local spawn shape. Opening
     * a channel starts the account's login shell (and its ~/.bashrc), so the
     * next command's channel is opened while the model is still thinking.
     * @type {Map<string, { handle: any, settled: boolean, generation: number, timer: NodeJS.Timeout }>}
     */
    this.warm = new Map()
    host.closeHooks.push(() => {
      for (const entry of this.warm.values()) {
        clearTimeout(entry.timer)
        entry.handle.terminate()
      }
      this.warm.clear()
    })
  }

  /**
   * A local ssh client whose remote side waits for "run" arguments on stdin.
   * @param {{ stdio: any, graceMs: number }} shape
   */
  openChannel(shape) {
    return this.local().spawn({
      argv: this.host.sshArgv(['sh', '-c', HELPER_BOOTSTRAP, 'sh', 'warm'], { master: false }),
      cwd: homedir(),
      ...shape,
      signal: undefined,
    })
  }

  /** @param {{ stdio: any, graceMs: number }} shape */
  takeWarm(shape) {
    const key = JSON.stringify(shape)
    const entry = this.warm.get(key)
    if (entry === undefined) return undefined
    this.warm.delete(key)
    clearTimeout(entry.timer)
    if (!entry.settled && entry.generation === this.host.generation) return entry.handle
    entry.handle.terminate()
    return undefined
  }

  /** @param {{ stdio: any, graceMs: number }} shape */
  prewarm(shape) {
    const key = JSON.stringify(shape)
    if (this.warm.has(key) || this.warm.size >= WARM_MAX) return
    const handle = this.openChannel(shape)
    handle.stdin?.on('error', () => {})
    const entry = {
      handle,
      settled: false,
      generation: this.host.generation,
      timer: setTimeout(() => {
        if (this.warm.get(key) !== entry) return
        this.warm.delete(key)
        handle.terminate()
      }, WARM_IDLE_MS),
    }
    entry.timer.unref?.()
    const settle = () => {
      entry.settled = true
      if (this.warm.get(key) === entry) this.warm.delete(key)
    }
    handle.done.then(settle, settle)
    this.warm.set(key, entry)
  }

  /**
   * @param {string} command
   * @param {Readonly<Record<string, string>> | undefined} _env
   * @param {AbortSignal} [signal]
   */
  async resolveExecutable(command, _env, signal) {
    const mapped = this.hooks.mapExecutable(command)
    const result = await this.host.helper('which', [mapped], { signal })
    if (result.code === 0) return result.stdout.toString('utf8').trim().split('\n')[0]
    if (result.code === 10) throw new SubprocessExecutableNotFoundError(`${command}: command not found on ${this.host.id}`)
    throw new Error(`cannot resolve ${command} on ${this.host.id}: ${result.stderr.trim() || `exit ${result.code}`}`)
  }

  /** @param {AbortSignal} [_signal] */
  async terminalEnvironment(_signal) {
    const info = await this.host.ready()
    return { platform: 'posix', defaultShell: shellOf(info) }
  }

  /**
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec} spec
   * @returns {import('@deepseek-ai/dsh-subprocess').SubprocessHandle}
   */
  spawn(spec) {
    const id = randomUUID().replaceAll('-', '').slice(0, 16)
    const stdin = spec.stdio.stdin
    const mode = stdin === 'ignore' ? 'ignore' : stdin === 'pipe' ? 'pipe' : 'data'
    const graceSec = Math.max(1, Math.ceil(spec.graceMs / 1000))
    const argv = [this.hooks.mapExecutable(spec.argv[0]), ...spec.argv.slice(1)]
    const runArgs = [id, mode, String(graceSec), spec.cwd, ...envEntries(spec.env, this.hooks.extraEnv()), '--', ...argv]
    // Keep the shared master (and its forwards) alive for later commands;
    // this client itself only joins an existing master or connects directly.
    this.hooks.ensureReady()
    this.host.mutated()
    const shape = { stdio: { stdin: 'pipe', stdout: spec.stdio.stdout, stderr: spec.stdio.stderr }, graceMs: spec.graceMs }
    const local = this.takeWarm(shape) ?? this.openChannel(shape)
    local.stdin?.write(Buffer.concat([Buffer.from(`${runArgs.length}\n`), ...runArgs.map(arg => encodeLine(Buffer.from(arg)))]))
    this.prewarm(shape)
    const host = this.host
    const logger = this.hooks.logger
    let terminated = false
    if (mode === 'data' && typeof stdin === 'object') {
      const data = Buffer.from(stdin.data, 'utf8')
      local.stdin?.on('error', () => {})
      local.stdin?.write(`${data.length}\n`)
      local.stdin?.write(data)
    } else if (mode === 'ignore') {
      local.stdin?.on('error', () => {})
    }
    const remoteSignal = (sig) => host.helper('signal', [id, sig]).catch((error) => {
      logger.debug?.(`[ssh-fleet] signal ${sig} ${id} on ${host.id}: ${error}`)
    })
    const terminate = () => {
      if (terminated) return
      terminated = true
      void remoteSignal('TERM')
      const timer = setTimeout(() => void remoteSignal('KILL'), spec.graceMs)
      timer.unref?.()
      local.terminate()
    }
    const done = local.done.finally(() => {
      host.mutated()
      // The lifeline is no longer needed once the client is gone.
      if (mode !== 'pipe') local.stdin?.destroy()
    })
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) queueMicrotask(terminate)
      else spec.signal.addEventListener('abort', terminate, { once: true })
      void done.finally(() => spec.signal?.removeEventListener('abort', terminate)).catch(() => {})
    }
    return {
      stdin: mode === 'pipe' ? local.stdin : undefined,
      stdout: local.stdout,
      stderr: local.stderr,
      control: undefined,
      collected: local.collected,
      done,
      terminate,
      async waitForExit(signal) {
        const aborted = new Promise((resolve) => {
          if (signal === undefined) return
          if (signal.aborted) resolve('aborted')
          else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        })
        // The outcome belongs to `done`; only the range matters here.
        if (await Promise.race([done.then(() => 'done', () => 'done'), aborted]) === 'aborted') return false
        for (;;) {
          if (signal?.aborted) return false
          const result = await host.helper('alive', [id], { signal }).catch((error) => {
            if (signal?.aborted) return undefined
            throw error
          })
          if (result === undefined) return false
          if (result.code === 10) return true
          if (result.code !== 0) {
            throw new Error(`cannot observe process range ${id} on ${host.id}: ${result.stderr.trim() || `exit ${result.code}`}`)
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      },
    }
  }

  /**
   * @param {import('@deepseek-ai/dsh-subprocess').SubprocessTerminalSpawnSpec} spec
   * @returns {Promise<import('@deepseek-ai/dsh-subprocess').SubprocessTerminalHandle>}
   */
  async spawnTerminal(spec) {
    await this.host.ready()
    this.host.mutated()
    const id = randomUUID().replaceAll('-', '').slice(0, 16)
    const argv = [this.hooks.mapExecutable(spec.argv[0]), ...spec.argv.slice(1)]
    const remote = ['sh', '-c', HELPER_BOOTSTRAP, 'sh', 'term', id, spec.cwd,
      ...envEntries(spec.env, { TERM: spec.terminalType, ...this.hooks.extraEnv() }), '--', ...argv]
    const local = await this.local().spawnTerminal({
      argv: this.host.sshArgv(remote, { tty: true, master: false }),
      cwd: homedir(),
      rows: spec.rows,
      cols: spec.cols,
      terminalType: spec.terminalType,
      graceMs: spec.graceMs,
      signal: spec.signal,
    })
    const host = this.host
    let revision = 0
    return {
      pid: local.pid,
      output: local.output,
      done: local.done,
      write: async (data) => {
        revision += 1
        await local.write(data)
      },
      resize: (cols, rows) => local.resize(cols, rows),
      async inspectForeground() {
        const result = await host.helper('fg', [id]).catch(() => undefined)
        const pgid = Number(result?.code === 0 ? result.stdout.toString('utf8').trim() : NaN)
        if (!Number.isSafeInteger(pgid) || pgid <= 0) return undefined
        return { processGroupId: pgid, inputWaiting: false }
      },
      async inspectActivity() {
        return { state: 'unknown', revision }
      },
      async signalForeground(signal) {
        const result = await host.helper('fgsignal', [id, signal.replace(/^SIG/, '')]).catch(() => undefined)
        const pgid = Number(result?.code === 0 ? result.stdout.toString('utf8').trim() : NaN)
        if (Number.isSafeInteger(pgid) && pgid > 0) return pgid
        const control = CONTROL_CHARS[/** @type {keyof typeof CONTROL_CHARS} */ (signal)]
        if (control === undefined) throw new Error(`cannot deliver ${signal} on ${host.id}: no foreground group`)
        await local.write(control)
        return 0
      },
      async terminate() {
        await local.terminate()
        await host.helper('forget', [id]).catch(() => {})
      },
    }
  }
}

/** @param {import('./ssh.js').RemoteInfo} info */
function shellOf(info) {
  return info.shell || info.commands.bash || '/bin/sh'
}
