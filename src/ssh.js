/**
 * One configured server: an OpenSSH ControlMaster connection plus the uploaded
 * remote helper. Every remote operation is a multiplexed `ssh` invocation of
 * the system OpenSSH client, so `~/.ssh/config` (ProxyJump, keys, agents,
 * known_hosts) applies unchanged.
 * @module dsh-ssh-fleet/ssh
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HELPER_TEXT = readFileSync(fileURLToPath(new URL('./remote/helper.sh', import.meta.url)), 'utf8')
const HELPER_HASH = createHash('sha256').update(HELPER_TEXT).digest('hex').slice(0, 16)

/**
 * Quote one argument for a POSIX shell.
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  if (value !== '' && /^[A-Za-z0-9_\-+=/.,:@%]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * @typedef {object} HostConfig
 * @property {string} id - Name used in commands, anchors and logs.
 * @property {string} host - OpenSSH destination: a `~/.ssh/config` alias or a hostname.
 * @property {string} [user]
 * @property {number} [port]
 * @property {string} [identityFile]
 * @property {string[]} [sshOptions] - Extra `-o Key=Value` options.
 * @property {string} [workspace] - Default remote working directory (absolute or `~/...`).
 * @property {string} [description]
 * @property {'auto'|'bwrap'|'unconfined'|'refuse'} [sandbox]
 * @property {boolean} [proxy] - Override the global proxy switch for this host.
 */

/**
 * @typedef {object} ExecResult
 * @property {number | null} code
 * @property {NodeJS.Signals | null} signal
 * @property {Buffer} stdout
 * @property {string} stderr
 */

export class SshError extends Error {
  /**
   * @param {string} message
   * @param {ExecResult} [result]
   */
  constructor(message, result) {
    super(message)
    this.name = 'SshError'
    this.result = result
  }
}

export class SshHost {
  /**
   * @param {HostConfig} config
   * @param {{ controlDir: string, connectTimeoutSec: number, helperWorkers?: number, logger: { info: Function, warn: Function, debug?: Function } }} options
   */
  constructor(config, options) {
    this.config = config
    this.id = config.id
    this.options = options
    /** @type {Promise<RemoteInfo> | undefined} */
    this.readyPromise = undefined
    /** @type {RemoteInfo | undefined} */
    this.info = undefined
    this.helperPath = ''
    /** Incremented whenever the master connection changes; per-connection state keys on it. */
    this.generation = 0
    /** @type {number | undefined} */
    this.masterPid = undefined
    this.masterCheckedAt = 0
    /** Bumped by every operation that may change files on the server. */
    this.mutations = 0
    this.workers = new WorkerPool(this, options.helperWorkers ?? 2)
    /** @type {(() => void)[]} Called when the connection is closed. */
    this.closeHooks = []
  }

  /**
   * Options shared by every invocation.
   * @param {boolean} [master] - whether this client may create the master
   *   connection. Clients started through the subprocess provider must not:
   *   a daemonized master would stay in that command's managed process range.
   */
  baseArgs(master = true) {
    const c = this.config
    const args = [
      '-o', `ControlMaster=${master ? 'auto' : 'no'}`,
      // Terminal input is model-controlled: "~." must not reach the client.
      '-o', 'EscapeChar=none',
      '-o', `ControlPath=${this.options.controlDir}/%C`,
      '-o', 'ControlPersist=600',
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${this.options.connectTimeoutSec}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'LogLevel=ERROR',
    ]
    if (c.port !== undefined) args.push('-p', String(c.port))
    if (c.user !== undefined) args.push('-l', c.user)
    if (c.identityFile !== undefined) args.push('-i', c.identityFile)
    for (const option of c.sshOptions ?? []) args.push('-o', option)
    return args
  }

  /**
   * Full local argv for running a remote argv over this host.
   * @param {readonly string[]} remoteArgv
   * @param {{ tty?: boolean, master?: boolean }} [opts]
   * @returns {string[]}
   */
  sshArgv(remoteArgv, opts = {}) {
    return ['ssh', ...this.baseArgs(opts.master ?? true), opts.tty ? '-tt' : '-T', '--', this.config.host, remoteArgv.map(shellQuote).join(' ')]
  }

  /**
   * Run a remote argv and collect its output.
   * @param {readonly string[]} remoteArgv
   * @param {{ input?: string | Buffer, signal?: AbortSignal, timeoutMs?: number }} [opts]
   * @returns {Promise<ExecResult>}
   */
  exec(remoteArgv, opts = {}) {
    const [cmd, ...args] = this.sshArgv(remoteArgv)
    return new Promise((resolve, reject) => {
      opts.signal?.throwIfAborted()
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      /** @type {Buffer[]} */
      const out = []
      /** @type {Buffer[]} */
      const err = []
      let settled = false
      const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
        child.kill('SIGTERM')
      }, opts.timeoutMs)
      const onAbort = () => child.kill('SIGTERM')
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', chunk => out.push(chunk))
      child.stderr.on('data', chunk => err.push(chunk))
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      child.on('close', (code, signal) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        if (opts.signal?.aborted) {
          reject(opts.signal.reason ?? new Error('aborted'))
          return
        }
        // 255 is ssh's own failure status: reconnect and re-provision next time.
        if (code === 255) this.readyPromise = undefined
        resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(opts.input ?? '')
    })
  }

  /**
   * Connect, probe the server and install the helper once.
   * @returns {Promise<RemoteInfo>}
   */
  async ready() {
    this.readyPromise ??= this.connect().catch((error) => {
      this.readyPromise = undefined
      throw error
    })
    const info = await this.readyPromise
    // ControlMaster=auto silently replaces a lost master; reverse forwards
    // die with the old one, so notice the change (throttled) and bump the
    // generation so callers re-provision.
    if (Date.now() - this.masterCheckedAt > 3000) {
      this.masterCheckedAt = Date.now()
      let pid = await this.checkMaster()
      if (pid === undefined) {
        // No master (expired or lost): open one now so forwards can attach.
        await this.exec(['true'])
        pid = await this.checkMaster()
      }
      if (pid !== this.masterPid) {
        this.masterPid = pid
        this.generation += 1
      }
    }
    return info
  }

  /** @returns {Promise<number | undefined>} the running master's pid. */
  async checkMaster() {
    const result = await runLocal('ssh', [...this.baseArgs(), '-O', 'check', '--', this.config.host]).catch(() => undefined)
    const match = /pid=(\d+)/.exec(`${result?.stderr ?? ''}${result?.stdout.toString('utf8') ?? ''}`)
    return match === null ? undefined : Number(match[1])
  }

  /** @returns {Promise<RemoteInfo>} */
  async connect() {
    // Reinstall the helper unless the installed copy still has the expected
    // digest (it runs outside any sandbox, so a modified copy must not run).
    const bootstrap = [
      'sh', '-c',
      'd="$HOME/.cache/dsh-ssh-fleet"; h="$d/helper-$1.sh"; t="$d/helper-$1.new.$$"; mkdir -p "$d" && chmod 700 "$d"; '
      + 'cat > "$t"; '
      + 'if ! cmp -s "$t" "$h" 2>/dev/null; then chmod 500 "$t" && mv -f "$t" "$h"; else rm -f "$t"; fi; '
      + 'exec sh "$h" info',
      'sh', HELPER_HASH,
    ]
    const result = await this.exec(bootstrap, { input: HELPER_TEXT, timeoutMs: this.options.connectTimeoutSec * 1000 + 15000 })
    if (result.code !== 0) {
      throw new SshError(`cannot connect to ${this.id} (${this.config.host}): ${result.stderr.trim() || `ssh exited with ${result.code ?? result.signal}`}`, result)
    }
    const info = parseInfo(result.stdout.toString('utf8'))
    const loginShell = info.shell.split('/').pop() ?? ''
    if (/^(t?csh|fish)$/.test(loginShell)) {
      throw new SshError(`cannot use ${this.id}: its login shell ${info.shell} does not parse POSIX quoting; use sh, bash, zsh or dash for this account`)
    }
    this.helperPath = `${info.home}/.cache/dsh-ssh-fleet/helper-${HELPER_HASH}.sh`
    this.info = info
    this.generation += 1
    this.masterPid = await this.checkMaster()
    this.masterCheckedAt = Date.now()
    this.options.logger.info(`[ssh-fleet] connected ${this.id}: ${info.os}/${info.arch}, home ${info.home}`)
    return info
  }

  /**
   * Invoke one helper operation.
   * @param {string} op
   * @param {readonly string[]} args
   * @param {{ input?: string | Buffer, signal?: AbortSignal, timeoutMs?: number }} [opts]
   * @returns {Promise<ExecResult>}
   */
  async helper(op, args, opts = {}) {
    await this.ready()
    if (READ_ONLY_OPS.has(op)) return await this.runHelper(op, args, opts)
    this.mutated()
    try {
      return await this.runHelper(op, args, opts)
    } finally {
      this.mutated()
    }
  }

  /**
   * Note that files on the server may have changed (a write, a command):
   * cached metadata taken before this point is no longer trusted.
   */
  mutated() {
    this.mutations += 1
  }

  /**
   * @param {string} op
   * @param {readonly string[]} args
   * @param {{ input?: string | Buffer, signal?: AbortSignal, timeoutMs?: number }} opts
   * @returns {Promise<ExecResult>}
   */
  async runHelper(op, args, opts) {
    const input = opts.input === undefined ? undefined : Buffer.from(opts.input)
    // Inputs a line-based worker cannot carry (NUL bytes) or would read
    // slowly (shells read pipes byte by byte) take a one-shot connection.
    const pooled = this.options.helperWorkers !== 0 && opts.timeoutMs === undefined
      && (input === undefined || (input.length <= WORKER_MAX_INPUT && !input.includes(0)))
    if (pooled) {
      try {
        return await this.workers.run([op, ...args], input, opts.signal)
      } catch (error) {
        if (!(error instanceof WorkerLostError)) throw error
        // The op may have run before the worker died: only repeat reads.
        if (error.maybeRan && !READ_ONLY_OPS.has(op)) return { code: 255, signal: null, stdout: Buffer.alloc(0), stderr: error.message }
      }
    }
    return await this.exec(['sh', this.helperPath, op, ...args], opts)
  }

  /** Remote argv prefix that runs one helper operation (for streaming spawns). */
  helperArgv(op, args) {
    return ['sh', this.helperPath, op, ...args]
  }

  /**
   * Add a reverse forward on the master connection.
   * @param {number} localPort
   * @returns {Promise<number>} the port allocated on the server's loopback.
   */
  async forwardReverse(localPort) {
    await this.ready()
    const args = [...this.baseArgs(), '-O', 'forward', '-R', `127.0.0.1:0:127.0.0.1:${localPort}`, '--', this.config.host]
    const result = await runLocal('ssh', args)
    const port = Number(result.stdout.toString('utf8').trim().split(/\s+/).pop())
    if (result.code !== 0 || !Number.isInteger(port) || port <= 0) {
      throw new SshError(`reverse forward on ${this.id} failed: ${result.stderr.trim()}`, result)
    }
    return port
  }

  /** Close the master connection. */
  async close() {
    this.workers.close()
    for (const hook of this.closeHooks) hook()
    if (this.readyPromise === undefined) return
    this.readyPromise = undefined
    await runLocal('ssh', [...this.baseArgs(), '-O', 'exit', '--', this.config.host]).catch(() => {})
  }
}

const WORKER_MAX_INPUT = 512 * 1024
const WORKER_IDLE_MS = 300_000
const WORKER_READY = Buffer.from('\n@@dsh-ssh-fleet-serve@@\n')
/** Ops that may safely run again when a worker died mid-request. */
const READ_ONLY_OPS = new Set(['info', 'resolve', 'probe', 'stat', 'lstat', 'list', 'read', 'range', 'readv', 'which', 'alive', 'fg'])

class WorkerLostError extends Error {
  /** @param {string} message @param {boolean} maybeRan - whether the server may have started the op. */
  constructor(message, maybeRan) {
    super(message)
    this.maybeRan = maybeRan
  }
}

/** One request line of the `serve`/`warm` protocol: "\" -> "\\", LF -> "\n". @param {Buffer} data */
export function encodeLine(data) {
  const out = Buffer.allocUnsafe(data.length * 2 + 1)
  let n = 0
  for (const byte of data) {
    if (byte === 0x5c) { out[n++] = 0x5c; out[n++] = 0x5c } else if (byte === 0x0a) { out[n++] = 0x5c; out[n++] = 0x6e } else out[n++] = byte
  }
  out[n++] = 0x0a
  return out.subarray(0, n)
}

/**
 * Long-lived `helper.sh serve` processes of one server. Every one-shot ssh
 * command starts the account's login shell, and bash runs ~/.bashrc for
 * commands from sshd; a worker pays that once and then runs ops from stdin.
 */
class WorkerPool {
  /** @param {SshHost} host @param {number} size */
  constructor(host, size) {
    this.host = host
    this.size = size
    /** @type {Set<HelperWorker>} */
    this.all = new Set()
    /** @type {HelperWorker[]} */
    this.idle = []
    /** @type {{ resolve: (worker: HelperWorker) => void, reject: (error: unknown) => void }[]} */
    this.waiting = []
  }

  /**
   * @param {string[]} argv - op and its arguments.
   * @param {Buffer | undefined} input
   * @param {AbortSignal} [signal]
   * @returns {Promise<ExecResult>}
   */
  async run(argv, input, signal) {
    signal?.throwIfAborted()
    const worker = await this.acquire(signal)
    try {
      return await worker.request(argv, input, signal)
    } finally {
      this.release(worker)
    }
  }

  /** @param {AbortSignal} [signal] @returns {Promise<HelperWorker>} */
  acquire(signal) {
    while (this.idle.length > 0) {
      const worker = /** @type {HelperWorker} */ (this.idle.pop())
      if (worker.alive && worker.generation === this.host.generation) return Promise.resolve(worker)
      worker.kill()
    }
    if (this.all.size < this.size) return Promise.resolve(this.spawn())
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      this.waiting.push(waiter)
      signal?.addEventListener('abort', () => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason ?? new Error('aborted'))
      }, { once: true })
    })
  }

  spawn() {
    const worker = new HelperWorker(this.host, () => this.forget(worker))
    this.all.add(worker)
    return worker
  }

  /** @param {HelperWorker} worker */
  release(worker) {
    if (!worker.alive) return
    const waiter = this.waiting.shift()
    if (waiter !== undefined) waiter.resolve(worker)
    else {
      this.idle.push(worker)
      worker.idleSince(() => {
        const index = this.idle.indexOf(worker)
        if (index >= 0) this.idle.splice(index, 1)
        worker.end()
      })
    }
  }

  /** @param {HelperWorker} worker */
  forget(worker) {
    this.all.delete(worker)
    const index = this.idle.indexOf(worker)
    if (index >= 0) this.idle.splice(index, 1)
    const waiter = this.waiting.shift()
    if (waiter !== undefined) waiter.resolve(this.spawn())
  }

  close() {
    for (const waiter of this.waiting.splice(0)) waiter.reject(new WorkerLostError('connection closed', false))
    for (const worker of this.all) worker.kill()
  }
}

class HelperWorker {
  /** @param {SshHost} host @param {() => void} onExit */
  constructor(host, onExit) {
    this.host = host
    this.generation = host.generation
    this.alive = true
    this.ready = false
    this.onExit = onExit
    /** @type {Buffer[]} */
    this.chunks = []
    this.length = 0
    /** Bytes needed before the next parse attempt. */
    this.needed = 0
    this.stderr = ''
    /** @type {{ resolve: (result: ExecResult) => void, reject: (error: unknown) => void, signal?: AbortSignal, onAbort: () => void } | undefined} */
    this.pending = undefined
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined
    // The worker attaches to the master only; ready() keeps one running.
    const [cmd, ...args] = host.sshArgv(['sh', host.helperPath, 'serve'], { master: false })
    this.child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.on('data', chunk => this.onData(chunk))
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-2000) })
    this.child.stdin.on('error', () => {})
    this.child.on('error', error => this.lost(error.message))
    this.child.on('close', code => this.lost(`exited with ${code}`))
    // A login shell that never reaches the helper (a hanging ~/.bashrc).
    this.startTimer = setTimeout(() => this.ready || this.kill(), host.options.connectTimeoutSec * 1000 + 30000)
    this.startTimer.unref()
  }

  /**
   * @param {string[]} argv
   * @param {Buffer | undefined} input
   * @param {AbortSignal} [signal]
   * @returns {Promise<ExecResult>}
   */
  request(argv, input, signal) {
    clearTimeout(this.timer)
    return new Promise((resolve, reject) => {
      if (!this.alive) {
        reject(new WorkerLostError(`helper worker on ${this.host.id} is gone`, false))
        return
      }
      const onAbort = () => {
        this.pending = undefined
        // The reply would desynchronize the stream: drop this worker.
        this.kill()
        reject(signal?.reason ?? new Error('aborted'))
      }
      this.pending = { resolve, reject, signal, onAbort }
      signal?.addEventListener('abort', onAbort, { once: true })
      const lines = [Buffer.from(`${argv.length} ${input === undefined ? 0 : 1}\n`), ...argv.map(arg => encodeLine(Buffer.from(arg)))]
      if (input !== undefined) lines.push(encodeLine(input))
      this.child.stdin.write(Buffer.concat(lines))
    })
  }

  /** @param {Buffer} chunk */
  onData(chunk) {
    this.chunks.push(chunk)
    this.length += chunk.length
    if (this.length < this.needed) return
    let buffer = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    if (!this.ready) {
      // Skip whatever the login shell printed before the helper started.
      const index = buffer.indexOf(WORKER_READY)
      if (index < 0) {
        buffer = buffer.subarray(Math.max(0, buffer.length - WORKER_READY.length))
        this.chunks = [buffer]
        this.length = buffer.length
        return
      }
      buffer = buffer.subarray(index + WORKER_READY.length)
      this.ready = true
      clearTimeout(this.startTimer)
    }
    while (this.pending !== undefined) {
      const eol = buffer.indexOf(0x0a)
      if (eol < 0) break
      const [code, outBytes, errBytes] = buffer.subarray(0, eol).toString('latin1').trim().split(/\s+/).map(Number)
      if (![code, outBytes, errBytes].every(Number.isInteger)) {
        this.kill()
        return
      }
      const end = eol + 1 + outBytes + errBytes
      if (buffer.length < end) {
        this.needed = end
        break
      }
      const stdout = Buffer.from(buffer.subarray(eol + 1, eol + 1 + outBytes))
      const stderr = buffer.subarray(eol + 1 + outBytes, end).toString('utf8')
      buffer = buffer.subarray(end)
      this.needed = 0
      const pending = this.pending
      this.pending = undefined
      pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.resolve({ code, signal: null, stdout, stderr })
    }
    this.chunks = buffer.length === 0 ? [] : [buffer]
    this.length = buffer.length
  }

  /** @param {() => void} expire */
  idleSince(expire) {
    clearTimeout(this.timer)
    this.timer = setTimeout(expire, WORKER_IDLE_MS)
    this.timer.unref()
  }

  /** Let the worker finish: EOF ends its loop. */
  end() {
    this.child.stdin.end()
  }

  kill() {
    if (this.alive) this.child.kill('SIGTERM')
    this.lost('stopped')
  }

  /** @param {string} reason */
  lost(reason) {
    if (!this.alive) return
    this.alive = false
    clearTimeout(this.timer)
    clearTimeout(this.startTimer)
    const pending = this.pending
    this.pending = undefined
    if (pending !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
      pending.reject(new WorkerLostError(`helper worker on ${this.host.id} ${reason}: ${this.stderr.trim()}`, this.ready))
    }
    this.onExit()
  }
}

/**
 * @typedef {object} RemoteInfo
 * @property {string} os
 * @property {string} arch
 * @property {string} home
 * @property {'gnu'|'bsd'} flavor
 * @property {string} shell
 * @property {Record<string, string>} commands
 */

/**
 * @param {string} text
 * @returns {RemoteInfo}
 */
function parseInfo(text) {
  /** @type {Record<string, string>} */
  const fields = {}
  for (const line of text.split('\n')) {
    const index = line.indexOf('=')
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1)
  }
  /** @type {Record<string, string>} */
  const commands = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith('cmd.') && value !== '') commands[key.slice(4)] = value
  }
  if (!fields.home?.startsWith('/')) throw new SshError(`unexpected helper info output: ${text.slice(0, 200)}`)
  return {
    os: fields.os ?? 'unknown',
    arch: fields.arch ?? 'unknown',
    home: fields.home,
    flavor: fields.flavor === 'bsd' ? 'bsd' : 'gnu',
    shell: fields.shell ?? '',
    commands,
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<ExecResult>}
 */
function runLocal(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }))
  })
}

export { HELPER_HASH }
