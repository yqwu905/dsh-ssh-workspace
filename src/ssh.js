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
   * @param {{ controlDir: string, connectTimeoutSec: number, logger: { info: Function, warn: Function, debug?: Function } }} options
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
  async helper(op, args, opts) {
    await this.ready()
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
    if (this.readyPromise === undefined) return
    this.readyPromise = undefined
    await runLocal('ssh', [...this.baseArgs(), '-O', 'exit', '--', this.config.host]).catch(() => {})
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
