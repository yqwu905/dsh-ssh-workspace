/**
 * Routing providers registered as the root `ctx.fs`, `ctx.subprocess` and
 * `ctx.sandbox`. Each call goes to the local providers (mounted in an
 * isolated group by this bundle's patch) or to the server the current
 * Session is bound to. Remote targets carry their server in the opaque
 * target key, so target-based operations route by identity, not by context.
 * @module dsh-ssh-fleet/router
 */

import { posix } from 'node:path'

/**
 * The host Node runtime (PTC/workflow workers) always runs on the host: it
 * speaks a control-channel protocol with this process, and its tool calls are
 * routed per Session anyway.
 * @param {string | undefined} program
 */
function isHostRuntime(program) {
  return program === process.execPath
}
import { FileSystem, FsError } from '@deepseek-ai/dsh-fs'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { hostOfTarget, posixFileUrl } from './remote-fs.js'

/**
 * @param {any} fleet
 * @param {{ targetKey: string }} target
 */
function remoteEntryOf(fleet, target) {
  const hostId = hostOfTarget(target)
  if (hostId === undefined) return undefined
  const entry = fleet.hosts.get(hostId)
  if (entry === undefined) throw new FsError(`server "${hostId}" is no longer configured`, 'FS_IO_ERROR')
  return entry
}

export class RoutedFileSystem extends FileSystem {
  static inject = ['sshFleet', 'sandboxPolicy']

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {{ diffBasisMaxBytes: number }} config
   */
  constructor(ctx, config) {
    super(ctx)
    this.fleet = ctx.sshFleet
    this.policy = ctx.sandboxPolicy
    this.diffBasisMaxBytes = config.diffBasisMaxBytes
  }

  get local() {
    return this.fleet.local.fs
  }

  /** @returns {any} */
  get sandboxMode() {
    return this.local.sandboxMode
  }

  /**
   * Absolute remote path for a requested path in a remote world.
   * @param {any} world
   * @param {string} path
   * @param {string | undefined} cwd
   * @param {AbortSignal} [signal]
   */
  async remotePath(world, path, cwd, signal) {
    const base = posix.isAbsolute(path) ? '' : cwd ?? await this.fleet.rootOf(world.entry, world.binding)
    const joined = base === '' ? path : `${base.replace(/\/$/, '')}/${path}`
    return await this.fleet.translate(world.entry, joined, signal)
  }

  /**
   * World for a path operation: the calling Session's server, else the server
   * an anchor path names (Web file views run outside any Agent).
   * @param {string} path
   * @param {string | undefined} cwd
   */
  worldFor(path, cwd) {
    const world = this.fleet.currentWorld()
    if (world !== undefined) return world
    const absolute = posix.isAbsolute(path) ? path : cwd === undefined ? undefined : posix.join(cwd, path)
    return absolute === undefined ? undefined : this.fleet.anchorWorld(absolute)
  }

  async resolve(path, opts) {
    const world = this.worldFor(path, opts?.cwd)
    if (world === undefined || (posix.isAbsolute(path) && this.fleet.isHostOwned(path))) return await this.local.resolve(path, opts)
    const remote = await this.remotePath(world, path, opts?.cwd, opts?.signal)
    return await world.entry.fs.resolve(remote, opts?.signal)
  }

  processPath(target) {
    const entry = remoteEntryOf(this.fleet, target)
    if (entry === undefined) return this.local.processPath(target)
    // Outside a server-bound Session (SDK/Web setting a directory, Web file
    // views) a remote path is spelled as its anchor, so it keeps naming its
    // server; the bound Session itself sees the plain remote path.
    if (this.fleet.currentBinding() === null && this.fleet.config.anchorsDir !== '') {
      return this.fleet.anchorPathFor(entry.id, target.displayPath)
    }
    return target.displayPath
  }

  processPathFromHostPath(hostPath) {
    const world = this.fleet.currentWorld()
    if (world === undefined) return this.local.processPathFromHostPath(hostPath)
    const translated = world.entry.translate(hostPath)
    if (translated.path !== hostPath) return translated.path
    // Host-created files and host runtime code stay addressable on the host.
    if (this.fleet.isHostOwned(hostPath) || hostPath.includes('/node_modules/')) return this.local.processPathFromHostPath(hostPath)
    return undefined
  }

  fileUrl(target) {
    return remoteEntryOf(this.fleet, target) === undefined ? this.local.fileUrl(target) : posixFileUrl(target.displayPath)
  }

  contains(parent, child) {
    const a = hostOfTarget(parent)
    const b = hostOfTarget(child)
    if (a !== b) return false
    if (a === undefined) return this.local.contains(parent, child)
    const root = parent.displayPath.replace(/\/$/, '')
    return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${root}/`)
  }

  async stat(target, signal) {
    const entry = remoteEntryOf(this.fleet, target)
    return entry === undefined ? await this.local.stat(target, signal) : await entry.fs.stat(target, signal)
  }

  async lstat(path, opts, signal) {
    const world = this.worldFor(path, opts?.cwd)
    if (world === undefined || (posix.isAbsolute(path) && this.fleet.isHostOwned(path))) return await this.local.lstat(path, opts, signal)
    return await world.entry.fs.lstat(await this.remotePath(world, path, opts?.cwd, signal), signal)
  }

  async readText(target, signal) {
    const entry = remoteEntryOf(this.fleet, target)
    return entry === undefined ? await this.local.readText(target, signal) : await entry.fs.readText(target, signal)
  }

  async streamText(target, signal) {
    const entry = remoteEntryOf(this.fleet, target)
    return entry === undefined ? await this.local.streamText(target, signal) : await entry.fs.streamText(target, signal)
  }

  async readBytes(target, signal, maxBytes) {
    const entry = remoteEntryOf(this.fleet, target)
    return entry === undefined ? await this.local.readBytes(target, signal, maxBytes) : await entry.fs.readBytes(target, signal, maxBytes)
  }

  async readByteRange(target, range, signal) {
    const entry = remoteEntryOf(this.fleet, target)
    return entry === undefined ? await this.local.readByteRange(target, range, signal) : await entry.fs.readByteRange(target, range, signal)
  }

  async listDir(target, signal) {
    const entry = remoteEntryOf(this.fleet, target)
    return entry === undefined ? await this.local.listDir(target, signal) : await entry.fs.listDir(target, signal)
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    const entry = remoteEntryOf(this.fleet, target)
    if (entry === undefined) return await this.local.writeText(target, content, expected, signal, sandboxPolicy)
    await this.fleet.checkWrite(entry, target, sandboxPolicy ?? this.policy.resolve())
    return await entry.fs.writeText(target, content, expected, signal, this.diffBasisMaxBytes)
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    const entry = remoteEntryOf(this.fleet, target)
    if (entry === undefined) return await this.local.editText(target, edit, expected, signal, sandboxPolicy)
    await this.fleet.checkWrite(entry, target, sandboxPolicy ?? this.policy.resolve())
    return await entry.fs.editText(target, edit, expected, signal)
  }

  watch(target, changed, signal) {
    const entry = remoteEntryOf(this.fleet, target)
    if (entry === undefined) return this.local.watch(target, changed, signal)
    signal.throwIfAborted()
    return Promise.reject(new FsError(`watching files on ${entry.id} is not supported`, 'FS_IO_ERROR'))
  }
}

export class RoutedSubprocess extends SubprocessRuntime {
  static inject = ['sshFleet']

  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx)
    this.fleet = ctx.sshFleet
  }

  get local() {
    return this.fleet.local.subprocess
  }

  async resolveExecutable(command, env, signal) {
    const world = this.fleet.currentWorld()
    if (world === undefined || isHostRuntime(command)) {
      return await this.local.resolveExecutable(command, env, signal)
    }
    return await world.entry.proc.resolveExecutable(command, env, signal)
  }

  async terminalEnvironment(signal) {
    const world = this.fleet.currentWorld()
    return world === undefined ? await this.local.terminalEnvironment(signal) : await world.entry.proc.terminalEnvironment(signal)
  }

  spawn(spec) {
    const world = this.fleet.currentWorld()
    if (world === undefined) return this.local.spawn(spec)
    // A control channel is a host-runtime protocol (PTC worker): keep it on
    // the host, in a host directory (the Session cwd is a server path).
    if (spec.stdio.control === 'pipe' || isHostRuntime(spec.argv[0])) return this.local.spawn({ ...spec, cwd: this.fleet.hostRuntimeDir })
    return world.entry.proc.spawn({ ...spec, cwd: world.entry.translate(spec.cwd).path })
  }

  async spawnTerminal(spec) {
    const world = this.fleet.currentWorld()
    if (world === undefined) return await this.local.spawnTerminal(spec)
    return await world.entry.proc.spawnTerminal({ ...spec, cwd: world.entry.translate(spec.cwd).path })
  }
}

export class RoutedSandbox extends SandboxProvider {
  static inject = ['sshFleet']

  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx)
    this.fleet = ctx.sshFleet
  }

  async confine(argv, policy, signal) {
    const world = this.fleet.currentWorld()
    if (world === undefined) return await this.fleet.local.sandbox.confine(argv, policy, signal)
    if (isHostRuntime(argv[0])) {
      return await this.fleet.local.sandbox.confine(argv, { ...policy, workspaceRoot: this.fleet.hostRuntimeDir }, signal)
    }
    signal?.throwIfAborted()
    return await this.fleet.confine(world.entry, argv, policy)
  }
}
