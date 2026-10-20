/**
 * `ctx.sshFleet`: the configured servers, per-Session bindings and the world
 * selection every routed capability uses.
 *
 * A Session is bound to a server by a durable plugin record in its own log
 * (`plugin:dsh-ssh-fleet/binding`), by inheriting its parent's binding
 * (subagents, forks), or by being created inside an anchor directory
 * `<anchorsDir>/<hostId>`. Work is attributed to a Session through the
 * Agent initiator scope (`ctx.agents.currentInitiator()`), which the agent
 * loop keeps active for everything it drives — prompt assembly, skills,
 * tools, background jobs — so every plugin that uses `ctx.fs`,
 * `ctx.subprocess` or `ctx.sandbox` follows the binding without changes.
 * @module dsh-ssh-fleet/fleet
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { MirrorManager } from './mirror.js'
import { startProxy } from './proxy.js'
import { RemoteFs } from './remote-fs.js'
import { RemoteProc } from './remote-proc.js'
import { SshHost, shellQuote } from './ssh.js'

export const BINDING_RECORD = 'plugin:dsh-ssh-fleet/binding'

/**
 * @typedef {object} Binding
 * @property {string} hostId
 * @property {string} [root] - canonical remote workspace root, when known.
 * @property {'record'|'parent'|'anchor'} source
 */

/** One configured server and its remote capability implementations. */
export class HostEntry {
  /**
   * @param {import('./ssh.js').HostConfig} config
   * @param {Fleet} fleet
   */
  constructor(config, fleet) {
    this.config = config
    this.id = config.id
    this.fleet = fleet
    this.ssh = new SshHost(config, {
      controlDir: fleet.controlDir,
      connectTimeoutSec: fleet.config.connectTimeoutSec,
      helperWorkers: fleet.config.helperWorkers,
      logger: fleet.logger,
    })
    this.fs = new RemoteFs(this.ssh)
    this.proc = new RemoteProc(this.ssh, () => fleet.local.subprocess, {
      extraEnv: () => this.extraEnv(),
      mapExecutable: argv0 => this.mapExecutable(argv0),
      ensureReady: () => {
        this.ready().catch(() => {
          // Reported through lastError and the command's own ssh failure.
        })
      },
      logger: fleet.logger,
    })
    /** @type {number | undefined} */
    this.proxyPort = undefined
    /** @type {string | undefined} */
    this.rgPath = undefined
    /** @type {string[]} */
    this.tmpRoots = ['/tmp', '/var/tmp']
    /** @type {Promise<void> | undefined} */
    this.provisioning = undefined
    /** Connection generation the current provisioning belongs to. */
    this.provisioned = -1
    /** @type {string | undefined} */
    this.lastError = undefined
  }

  /**
   * Connect (reconnecting after a lost master) and run the per-connection
   * provisioning: reverse proxy forward and ripgrep upload.
   * @returns {Promise<import('./ssh.js').RemoteInfo>}
   */
  async ready() {
    let info
    try {
      info = await this.ssh.ready()
      const generation = this.ssh.generation
      if (this.provisioned !== generation) {
        this.provisioning ??= this.fleet.provision(this, info).then(() => {
          this.provisioned = generation
        }).finally(() => {
          this.provisioning = undefined
        })
        await this.provisioning
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
    this.lastError = undefined
    return info
  }

  get info() {
    return this.ssh.info
  }

  /** Whether the proxy applies to this server. */
  get proxyEnabled() {
    return this.config.proxy ?? this.fleet.config.proxy.enabled
  }

  /** Environment added to every remote process. */
  extraEnv() {
    if (this.proxyPort === undefined) return {}
    const url = `http://${this.proxyCredential}@127.0.0.1:${this.proxyPort}`
    return {
      HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url,
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    }
  }

  /**
   * Host-packaged executables (absolute paths inside node_modules, such as the
   * ripgrep binary used by glob/grep) do not exist on the server; use the
   * provisioned copy or the server's own command of the same name.
   * @param {string} argv0
   */
  mapExecutable(argv0) {
    if (!argv0.startsWith('/') || !argv0.includes('/node_modules/')) return argv0
    const name = posix.basename(argv0)
    if (name === 'rg') return this.rgPath ?? this.info?.commands.rg ?? 'rg'
    return name
  }

  /** Host-to-remote prefix mappings (mirrors and this server's anchor). */
  mappings() {
    const info = this.info
    if (info === undefined) return []
    const list = this.fleet.mirrors.mappings(info.home)
    const anchor = this.fleet.anchorDir(this.id)
    if (anchor !== undefined) {
      list.push({ hostPath: anchor, remotePath: this.fleet.expandRemote(this.config.workspace ?? '~', info.home), kind: 'anchor' })
    }
    return list.sort((a, b) => b.hostPath.length - a.hostPath.length)
  }

  /**
   * Translate a host-owned absolute path into its remote counterpart.
   * @param {string} path
   * @returns {{ path: string, mirror?: string }}
   */
  translate(path) {
    for (const mapping of this.mappings()) {
      if (path === mapping.hostPath || path.startsWith(`${mapping.hostPath}/`)) {
        const rest = path.slice(mapping.hostPath.length)
        // Anchors encode remote directories: <anchorsDir>/<host>/<absolute
        // remote path>; the bare anchor stands for the server's workspace.
        if (mapping.kind === 'anchor') return { path: rest === '' ? mapping.remotePath : rest }
        return {
          path: mapping.remotePath + rest,
          ...mapping.kind === 'mirror' ? { mirror: mapping.hostPath } : {},
        }
      }
    }
    return { path }
  }
}

export class Fleet extends Service {
  static inject = ['sshFleetLocal', 'sessions', 'agents']

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {import('./config.js').FleetConfig} config
   */
  constructor(ctx, config) {
    super(ctx, 'sshFleet')
    this.config = config
    this.logger = ctx.logger('ssh-fleet')
    const local = ctx.sshFleetLocal
    /** Local providers captured from the isolated group (never `this.ctx`). */
    this.local = { fs: local.fs, subprocess: local.subprocess, sandbox: local.sandbox }
    this.sessions = ctx.sessions
    this.agents = ctx.agents
    this.controlDir = config.controlDir ?? defaultControlDir()
    ensurePrivateDir(this.controlDir)
    // sun_path holds ~104 bytes; OpenSSH appends a 40-char %C hash plus a
    // 17-char temporary suffix while creating the master.
    if (this.controlDir.length + 1 + 40 + 17 > 100) {
      throw new Error(`ssh-fleet: controlDir ${this.controlDir} is too long for ssh control sockets; configure a shorter controlDir`)
    }
    /** Private host directory used as cwd/workspace of host-side runtimes (PTC workers). */
    this.hostRuntimeDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-fleet-rt-'))
    const skillRoots = config.mirrorSkills ? [join(config.dshHome, 'skills'), join(config.agentsHome, 'skills')] : []
    this.mirrors = new MirrorManager([...skillRoots, ...config.mirrors], config.mirrorCheckIntervalMs, this.logger)
    // The host's dsh and agents homes (global AGENTS.md and the like) are the
    // one configuration every server shares, so they are read on the host;
    // mirrored roots and anchors inside them still name server paths.
    this.configHomes = [config.dshHome, config.agentsHome].map(p => resolve(p))
    this.configHomeExceptions = [...skillRoots, ...config.mirrors, config.anchorsDir].filter(p => p !== '').map(p => resolve(p))
    /** @type {Map<string, HostEntry>} */
    this.hosts = new Map()
    /** @type {WeakMap<object, { next: number, binding: Binding | null | undefined }>} */
    this.recordCache = new WeakMap()
    /** @type {Map<string, Promise<string>>} */
    this.rootCache = new Map()
    /** @type {Promise<{ port: number, close: () => Promise<void> }> | undefined} */
    this.proxy = undefined
    // Host-created output (spill files) referenced by tool results.
    this.hostPrefixes = [join(tmpdir(), 'dsh-subprocess-'), join(tmpdir(), 'dsh-spill-'), ...config.hostPaths.map(p => resolve(p))]
    this.applyHosts(config.hosts)
    ctx.effect(() => () => this.dispose())
  }

  /**
   * Replace the host table (inline config plus the hosts file).
   * @param {import('./ssh.js').HostConfig[]} hosts
   */
  applyHosts(hosts) {
    for (const config of hosts) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.id)) throw new Error(`ssh-fleet: invalid host id "${config.id}"`)
      const existing = this.hosts.get(config.id)
      if (existing !== undefined && JSON.stringify(existing.config) === JSON.stringify(config)) continue
      if (existing !== undefined) void existing.ssh.close()
      this.hosts.set(config.id, new HostEntry(config, this))
      const anchor = this.anchorDir(config.id)
      if (anchor !== undefined) mkdirSync(anchor, { recursive: true })
    }
  }

  /** Re-read the hosts file and merge it with the inline hosts. */
  async reloadHosts() {
    const hosts = [...this.config.inlineHosts ?? [], ...await readHostsFile(this.config.hostsFile)]
    const ids = new Set(hosts.map(h => h.id))
    for (const [id, entry] of this.hosts) {
      if (!ids.has(id)) {
        void entry.ssh.close()
        this.hosts.delete(id)
      }
    }
    this.applyHosts(hosts)
    return hosts.length
  }

  /** @param {string} hostId */
  anchorDir(hostId) {
    return this.config.anchorsDir === '' ? undefined : join(this.config.anchorsDir, hostId)
  }

  /**
   * @param {string} path
   * @param {string} home
   */
  expandRemote(path, home) {
    if (path === '~') return home
    if (path.startsWith('~/')) return `${home}${path.slice(1)}`
    return path
  }

  /** @param {string} hostId */
  entry(hostId) {
    const entry = this.hosts.get(hostId)
    if (entry === undefined) throw new Error(`ssh-fleet: unknown host "${hostId}"`)
    return entry
  }

  // --- Bindings -----------------------------------------------------------

  /**
   * The binding recorded in one Session's own log, scanning only new events.
   * @param {any} session
   * @returns {Binding | null | undefined} null = explicitly local, undefined = no record.
   */
  recordedBinding(session) {
    let cache = this.recordCache.get(session)
    if (cache === undefined) {
      cache = { next: 0, binding: undefined }
      this.recordCache.set(session, cache)
    }
    const end = Number(session.seq)
    for (let seq = cache.next; seq < end; seq++) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      const record = pluginRecordOf(event)
      if (record?.type !== BINDING_RECORD) continue
      const data = /** @type {any} */ (record.data)
      cache.binding = typeof data?.host === 'string'
        ? { hostId: data.host, ...typeof data.root === 'string' ? { root: data.root } : {}, source: 'record' }
        : null
    }
    cache.next = end
    return cache.binding
  }

  /**
   * Effective binding of a Session.
   * @param {any} session
   * @returns {Binding | null}
   */
  bindingOf(session, depth = 0) {
    const recorded = this.recordedBinding(session)
    // A record naming a server that is no longer configured stays a remote
    // binding: currentWorld() refuses work instead of running it locally.
    if (recorded !== undefined) return recorded
    const parentId = session.header?.parentSession
    if (parentId !== undefined && depth < 16) {
      const parent = this.sessions.get(parentId)
      if (parent !== undefined) {
        const inherited = this.bindingOf(parent, depth + 1)
        if (inherited !== null) return { ...inherited, source: 'parent' }
      }
    }
    const hostId = typeof session.header?.cwd === 'string' ? this.anchorHostOf(session.header.cwd) : undefined
    return hostId === undefined ? null : { hostId, source: 'anchor' }
  }

  /**
   * Host placeholder directory that stands for one remote directory.
   * @param {string} hostId
   * @param {string} remotePath - absolute remote path other than "/".
   */
  anchorPathFor(hostId, remotePath) {
    const anchor = this.anchorDir(hostId)
    if (anchor === undefined) throw new Error('ssh-fleet: anchors are disabled (anchorsDir is empty)')
    return `${anchor}${remotePath}`
  }

  /**
   * World for work outside any Agent (Web file views): an anchor path
   * names its server.
   * @param {string} path - absolute host path.
   * @returns {{ entry: HostEntry, binding: Binding } | undefined}
   */
  anchorWorld(path) {
    const hostId = this.anchorHostOf(path)
    const entry = hostId === undefined ? undefined : this.hosts.get(hostId)
    return entry === undefined || hostId === undefined ? undefined : { entry, binding: { hostId, source: 'anchor' } }
  }

  /**
   * Server whose anchor directory contains a host path.
   * @param {string} path
   * @returns {string | undefined}
   */
  anchorHostOf(path) {
    if (this.config.anchorsDir === '' || !isAbsolute(path)) return undefined
    const rel = relative(this.config.anchorsDir, path)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
    const hostId = rel.split(sep)[0]
    return this.hosts.has(hostId) ? hostId : undefined
  }

  /** Binding of the Agent whose work is currently running, if any. */
  currentBinding() {
    const agent = this.agents?.currentInitiator?.()
    if (agent === undefined) return null
    return this.bindingOf(agent.session)
  }

  /**
   * The world for the current work: undefined = local.
   * @returns {{ entry: HostEntry, binding: Binding } | undefined}
   */
  currentWorld() {
    const binding = this.currentBinding()
    if (binding === null) return undefined
    const entry = this.hosts.get(binding.hostId)
    if (entry === undefined) {
      throw new Error(`this session is bound to server "${binding.hostId}", which is no longer configured; `
        + 'restore it in the hosts file and run /ssh reload, or run /ssh local')
    }
    return { entry, binding }
  }

  /**
   * Canonical remote workspace root of a binding.
   * @param {HostEntry} entry
   * @param {Binding} binding
   */
  async rootOf(entry, binding) {
    if (binding.root !== undefined) return binding.root
    const info = await entry.ready()
    const configured = this.expandRemote(entry.config.workspace ?? '~', info.home)
    const key = `${entry.id}\0${configured}`
    let pending = this.rootCache.get(key)
    if (pending === undefined) {
      pending = entry.fs.resolve(configured).then(t => t.displayPath)
      pending.catch(() => this.rootCache.delete(key))
      this.rootCache.set(key, pending)
    }
    return await pending
  }

  /**
   * Durably bind (or unbind with `hostId === null`) one Session.
   * @param {any} session
   * @param {string | null} hostId
   * @param {string} [root]
   */
  record(session, hostId, root) {
    appendPluginRecord(session, BINDING_RECORD, hostId === null ? { host: null } : { host: hostId, root: root ?? null })
  }

  // --- Paths ----------------------------------------------------------------

  /**
   * Host-owned paths (spill files and similar) stay on the host even in a
   * remote Session, because the host process created them.
   * @param {string} path
   */
  isHostOwned(path) {
    const normalized = resolve(path)
    if (this.hostPrefixes.some(prefix => normalized.startsWith(prefix)) && existsSync(normalized)) return true
    const within = (/** @type {string} */ root) => normalized === root || normalized.startsWith(`${root}/`)
    return this.configHomes.some(within) && !this.configHomeExceptions.some(within)
  }

  /**
   * Remote state directory of a server (helper, mirrors, run records); it
   * is never writable for confined work.
   * @param {import('./ssh.js').RemoteInfo} info
   */
  stateDir(info) {
    return `${info.home}/.cache/dsh-ssh-fleet`
  }

  /**
   * Translate one absolute path for a remote world and refresh its mirror.
   * @param {HostEntry} entry
   * @param {string} path
   * @param {AbortSignal} [signal]
   */
  async translate(entry, path, signal) {
    await entry.ready()
    const translated = entry.translate(path)
    if (translated.mirror !== undefined) {
      signal?.throwIfAborted()
      try {
        await this.mirrors.ensure(entry.ssh, translated.mirror)
      } catch (error) {
        this.logger.warn(`[ssh-fleet] ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return translated.path
  }

  // --- Policy ------------------------------------------------------------------

  /**
   * Enforce the file-write policy for a remote target (the fs-sandbox rules,
   * applied to remote canonical paths with the binding's workspace root).
   * @param {HostEntry} entry
   * @param {{ displayPath: string }} target
   * @param {{ mode: string }} policy
   */
  async checkWrite(entry, target, policy) {
    const { mode } = policy
    if (mode === 'danger-full-access') return
    if (mode === 'read-only') {
      throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, 'FS_SANDBOX_DENIED')
    }
    const info = await entry.ready()
    const path = target.displayPath
    const under = root => path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
    if (under(this.stateDir(info))) {
      throw new FsError(`cannot write "${path}": the dsh-ssh-fleet state directory is protected under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
    const binding = this.currentBinding()
    const roots = [...entry.tmpRoots]
    if (binding !== null && binding.hostId === entry.id) roots.push(await this.rootOf(entry, binding))
    if (!roots.some(under)) {
      throw new FsError(`cannot write "${path}": file access denied under workspace-write mode`, 'FS_SANDBOX_DENIED')
    }
  }

  /**
   * Remote command confinement.
   * @param {HostEntry} entry
   * @param {readonly string[]} argv
   * @param {{ mode: 'read-only'|'workspace-write' }} policy
   */
  async confine(entry, argv, policy) {
    const info = await entry.ready()
    const setting = entry.config.sandbox ?? this.config.sandbox
    const bwrap = info.commands.bwrap
    if (setting === 'unconfined') {
      if (!this.warnedUnconfined?.has(entry.id)) {
        (this.warnedUnconfined ??= new Set()).add(entry.id)
        this.logger.warn(`[ssh-fleet] ${entry.id}: sandbox=unconfined, commands run without file-effect confinement in ${policy.mode} mode`)
      }
      return { argv: [...argv], enforcement: 'partial', denialSignatures: [], runnerFailureRules: [] }
    }
    if (setting === 'refuse' || bwrap === undefined || info.os !== 'Linux') {
      throw new SandboxUnavailableError(policy.mode, `remote host ${entry.id} has no usable bubblewrap; install bwrap there, `
        + 'switch this session to danger-full-access, or set sandbox: unconfined for the host')
    }
    const binding = this.currentBinding()
    const root = binding !== null && binding.hostId === entry.id ? await this.rootOf(entry, binding) : undefined
    // Same profile as dsh-sandbox-local's bwrap backend, plus a read-only
    // state directory (the helper runs unconfined and must stay intact).
    const args = [bwrap, '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
    if (policy.mode === 'workspace-write') {
      args.push('--tmpfs', '/tmp')
      if (root !== undefined) args.push('--bind', root, root)
    }
    const state = this.stateDir(info)
    args.push('--ro-bind-try', state, state)
    return {
      argv: [...args, '--', ...argv],
      enforcement: 'partial',
      denialSignatures: ['Read-only file system'],
      runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
    }
  }

  // --- Provisioning --------------------------------------------------------------

  /**
   * One-time setup after a server connects: proxy forward, ripgrep.
   * @param {HostEntry} entry
   * @param {import('./ssh.js').RemoteInfo} info
   */
  async provision(entry, info) {
    entry.proxyPort = undefined
    // Canonical temporary roots (macOS: /tmp -> /private/tmp).
    const tmpRoots = new Set(['/tmp', '/var/tmp'])
    for (const dir of ['/tmp', '/var/tmp']) {
      const target = await entry.fs.resolve(dir).catch(() => undefined)
      if (target !== undefined) tmpRoots.add(target.displayPath)
    }
    entry.tmpRoots = [...tmpRoots]
    if (entry.proxyEnabled) {
      try {
        this.proxy ??= startProxy({ allow: this.config.proxy.allow, allowPrivate: this.config.proxy.allowPrivate, upstream: this.config.proxy.upstream, logger: this.logger })
        const proxy = await this.proxy
        entry.proxyPort = await entry.ssh.forwardReverse(proxy.port)
        entry.proxyCredential = `${proxy.user}:${proxy.token}`
        this.logger.info(`[ssh-fleet] ${entry.id}: proxy available at 127.0.0.1:${entry.proxyPort}`)
      } catch (error) {
        this.logger.warn(`[ssh-fleet] ${entry.id}: proxy forward failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (info.commands.rg === undefined && this.config.uploadRipgrep) {
      const hostRg = findHostRipgrep()
      if (hostRg !== undefined && samePlatform(info)) {
        const data = await readFile(hostRg)
        const tag = createHash('sha256').update(data).digest('hex').slice(0, 12)
        const target = `${info.home}/.cache/dsh-ssh-fleet/bin/rg-${tag}`
        const script = `t=${shellQuote(target)}; if [ -x "$t" ]; then cat >/dev/null; else mkdir -p "$(dirname "$t")" && cat > "$t.$$" && chmod 755 "$t.$$" && mv -f "$t.$$" "$t"; fi`
        const result = await entry.ssh.exec(['sh', '-c', script], { input: data })
        if (result.code === 0) entry.rgPath = target
        else this.logger.warn(`[ssh-fleet] ${entry.id}: ripgrep upload failed: ${result.stderr.trim()}`)
      }
    }
  }

  async dispose() {
    await Promise.allSettled([...this.hosts.values()].map(entry => entry.ssh.close()))
    if (this.proxy !== undefined) await (await this.proxy.catch(() => undefined))?.close()
  }
}

/** Short default for ssh control sockets (macOS tmpdir paths are too long). */
function defaultControlDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `/tmp/dsh-sf-${uid}`
}

/**
 * Create a directory only this user can use, refusing one that another
 * user created or redirected (shared /tmp).
 * @param {string} dir
 */
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const info = lstatSync(dir)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`ssh-fleet: ${dir} is not a private directory owned by this user`)
  }
  if ((info.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}

/** @param {string} path */
export async function readHostsFile(path) {
  if (path === '') return []
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (/** @type {any} */ (error).code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(text)
  const hosts = Array.isArray(parsed) ? parsed : parsed?.hosts
  if (!Array.isArray(hosts)) throw new Error(`ssh-fleet: ${path} must contain an array or { "hosts": [...] }`)
  return hosts
}

/** Locate the ripgrep binary that dsh's glob/grep tools use. */
function findHostRipgrep() {
  try {
    const require = createRequire(import.meta.url)
    const search = dirname(require.resolve('@deepseek-ai/dsh-tool-fs-search/package.json'))
    const ripgrep = createRequire(join(search, 'package.json'))
    const { rgPath } = ripgrep('@vscode/ripgrep')
    return typeof rgPath === 'string' && existsSync(rgPath) ? rgPath : undefined
  } catch {
    return undefined
  }
}

/** @param {import('./ssh.js').RemoteInfo} info */
function samePlatform(info) {
  const os = { linux: 'Linux', darwin: 'Darwin' }[platform()]
  const machine = { x64: ['x86_64', 'amd64'], arm64: ['aarch64', 'arm64'] }[arch()] ?? []
  return os === info.os && machine.includes(info.arch)
}

