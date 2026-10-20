/**
 * Host directory mirrors: keep copies of host-owned directories (skill roots
 * by default) on each server so that skill bodies, scripts and assets resolve
 * to real files where commands run. The router translates the host path to
 * the mirror path, so the model only ever sees paths that exist remotely.
 * @module dsh-ssh-fleet/mirror
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const MAX_FILES = 20000
const MAX_DEPTH = 12

/**
 * Cheap change signature of a host directory: relative path, size and mtime
 * of every file (symlinks followed).
 * @param {string} root
 * @returns {Promise<string>}
 */
export async function directorySignature(root) {
  const hash = createHash('sha256')
  let files = 0
  /** @param {string} dir @param {string} rel @param {number} depth */
  async function walk(dir, rel, depth) {
    if (depth > MAX_DEPTH || files > MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    entries.sort()
    for (const name of entries) {
      const path = join(dir, name)
      let info
      try {
        info = await stat(path)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        hash.update(`d:${rel}${name}\n`)
        await walk(path, `${rel}${name}/`, depth + 1)
      } else if (info.isFile()) {
        files += 1
        hash.update(`f:${rel}${name}:${info.size}:${info.mtimeMs}\n`)
      }
    }
  }
  try {
    const info = await stat(root)
    if (!info.isDirectory()) return 'absent'
  } catch {
    return 'absent'
  }
  await walk(root, '', 0)
  return hash.digest('hex').slice(0, 32)
}

/**
 * @param {string} hostDir
 * @returns {Promise<Buffer>}
 */
function tarDirectory(hostDir) {
  return new Promise((resolve, reject) => {
    // -h: skill roots are often symlinks into other checkouts.
    const child = spawn('tar', ['-C', hostDir, '-chf', '-', '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new Error(`tar ${hostDir} failed: ${Buffer.concat(err).toString('utf8').trim()}`))
    })
  })
}

const INSTALL_SCRIPT = 'set -e; m=$1; sig=$2; rm -rf "$m.new"; mkdir -p "$m.new"; '
  + 'if [ "$sig" != absent ]; then tar -C "$m.new" -xf -; else cat >/dev/null; fi; '
  + 'printf %s "$sig" > "$m.new/.dsh-ssh-fleet-sig"; rm -rf "$m.old"; '
  + '[ -e "$m" ] && mv "$m" "$m.old"; mv "$m.new" "$m"; rm -rf "$m.old"'

export class MirrorManager {
  /**
   * @param {string[]} hostDirs - absolute host directories to mirror.
   * @param {number} checkIntervalMs
   * @param {any} logger
   */
  constructor(hostDirs, checkIntervalMs, logger) {
    this.hostDirs = [...new Set(hostDirs)]
    this.checkIntervalMs = checkIntervalMs
    this.logger = logger
    /** @type {Map<string, { pushed?: string, checkedAt: number, pending?: Promise<void> }>} */
    this.state = new Map()
  }

  /**
   * Mirror location of one host directory on a server.
   * @param {string} home - the server's $HOME.
   * @param {string} hostDir
   */
  remotePath(home, hostDir) {
    const tag = createHash('sha256').update(hostDir).digest('hex').slice(0, 12)
    return `${home}/.cache/dsh-ssh-fleet/mirror/${tag}-${basename(hostDir) || 'root'}`
  }

  /**
   * Host-to-remote prefix mappings for one connected server.
   * @param {string} home
   */
  mappings(home) {
    return this.hostDirs.map(hostDir => ({ hostPath: hostDir, remotePath: this.remotePath(home, hostDir), kind: 'mirror' }))
  }

  /**
   * Make the mirror of `hostDir` on `host` current (throttled, deduplicated).
   * @param {import('./ssh.js').SshHost} host
   * @param {string} hostDir
   * @returns {Promise<void>}
   */
  async ensure(host, hostDir) {
    const info = await host.ready()
    const key = `${host.id}\0${hostDir}`
    let state = this.state.get(key)
    if (state === undefined) {
      state = { checkedAt: 0 }
      this.state.set(key, state)
    }
    if (state.pending !== undefined) return await state.pending
    if (state.pushed !== undefined && Date.now() - state.checkedAt < this.checkIntervalMs) return
    const current = state
    current.pending = (async () => {
      const remote = this.remotePath(info.home, hostDir)
      const signature = await directorySignature(hostDir)
      if (current.pushed === undefined) {
        const existing = await host.exec(['cat', `${remote}/.dsh-ssh-fleet-sig`]).catch(() => undefined)
        if (existing?.code === 0) current.pushed = existing.stdout.toString('utf8').trim()
      }
      if (current.pushed !== signature) {
        const archive = signature === 'absent' ? Buffer.alloc(0) : await tarDirectory(hostDir)
        const result = await host.exec(['sh', '-c', INSTALL_SCRIPT, 'sh', remote, signature], { input: archive })
        if (result.code !== 0) throw new Error(`mirror ${hostDir} -> ${host.id}:${remote} failed: ${result.stderr.trim()}`)
        this.logger.info(`[ssh-fleet] mirrored ${hostDir} -> ${host.id}:${remote} (${archive.length} bytes)`)
        current.pushed = signature
      }
      current.checkedAt = Date.now()
    })().finally(() => {
      current.pending = undefined
    })
    return await current.pending
  }
}
