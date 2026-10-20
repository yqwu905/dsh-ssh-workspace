/**
 * Remote implementation of the `ctx.fs` operations for one server. The router
 * owns path translation and policy; this class only speaks to the helper.
 * Semantics follow `dsh-fs-local`: UTF-8 text with NUL-byte binary rejection,
 * LF-normalized edit/diff bases with CRLF restoration, guarded writes.
 * @module dsh-ssh-fleet/remote-fs
 */

import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import { FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'

const BINARY_SAMPLE_BYTES = 8192
/**
 * How long resolve/stat answers are reused. dsh probes the same paths
 * several times while assembling one request (working directory, .git and
 * instruction files), each a round trip here; any write or command through
 * this plugin drops the cache at once, so the window only covers changes made
 * on the server by others.
 */
const METADATA_TTL_MS = 1000
const KEY_PREFIX = 'ssh-fleet://'

/** Exit codes of helper.sh mapped to FsError codes. */
const EXIT_CODES = {
  10: 'FS_NOT_FOUND',
  11: 'FS_NOT_DIRECTORY',
  12: 'FS_NOT_REGULAR_FILE',
  13: 'FS_PERMISSION_DENIED',
  14: 'FS_TOO_LARGE',
  15: 'FS_STALE_VERSION',
  16: 'FS_NOT_OBSERVED',
}

const MESSAGES = {
  FS_NOT_FOUND: 'not found',
  FS_NOT_DIRECTORY: 'not a directory',
  FS_NOT_REGULAR_FILE: 'not a regular file',
  FS_PERMISSION_DENIED: 'permission denied',
  FS_TOO_LARGE: 'file too large',
  FS_STALE_VERSION: 'file changed since it was last read',
  FS_NOT_OBSERVED: 'file already exists',
}

/**
 * @param {string} hostId
 * @param {string} path
 */
export function remoteTargetKey(hostId, path) {
  return FsTargetKey(`${KEY_PREFIX}${hostId}${path}`)
}

/**
 * Host id of a target produced by a remote world, or undefined for local targets.
 * @param {{ targetKey: string }} target
 * @returns {string | undefined}
 */
export function hostOfTarget(target) {
  const key = String(target.targetKey)
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const rest = key.slice(KEY_PREFIX.length)
  const slash = rest.indexOf('/')
  return slash < 0 ? rest : rest.slice(0, slash)
}

/** @param {string} content */
export function normalizeLineEndings(content) {
  return content.replaceAll('\r\n', '\n')
}

/** @param {string} raw */
function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf ? 'CRLF' : 'LF'
}

/**
 * @param {string} content
 * @param {'LF'|'CRLF'} lineEndings
 */
function restoreLineEndings(content, lineEndings) {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** @param {string} content @param {string} needle */
function countOccurrences(content, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {'read'|'edit'} verb
 * @param {string} displayPath
 */
function decodeText(bytes, verb, displayPath) {
  const sample = verb === 'read' ? bytes.subarray(0, BINARY_SAMPLE_BYTES) : bytes
  if (sample.includes(0)) throw new FsError(`cannot ${verb} "${displayPath}": binary file`, 'FS_NOT_TEXT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT')
  }
}

/** @param {string} raw */
function typeOf(raw) {
  const t = raw.toLowerCase()
  if (t.startsWith('regular')) return 'file'
  if (t === 'directory') return 'directory'
  if (t.startsWith('symbolic')) return 'symlink'
  return 'other'
}

/**
 * Parse `type|size|version` (as printed by the helper's stat functions).
 * @param {string} line
 */
function parseStat(line) {
  const first = line.indexOf('|')
  const second = line.indexOf('|', first + 1)
  if (first < 0 || second < 0) throw new FsError(`unexpected remote stat output: ${line.slice(0, 120)}`, 'FS_IO_ERROR')
  const type = typeOf(line.slice(0, first))
  const size = Number(line.slice(first + 1, second))
  return { type, size: Number.isFinite(size) ? size : undefined, version: FsVersion(line.slice(second + 1)) }
}

/** `stat()` result of a parsed stat line. @param {ReturnType<typeof parseStat>} info */
function statOf(info) {
  return { version: info.version, type: info.type === 'symlink' ? 'other' : info.type, ...info.size !== undefined && info.type === 'file' ? { size: info.size } : {} }
}

export class RemoteFs {
  /**
   * @param {import('./ssh.js').SshHost} host
   */
  constructor(host) {
    this.host = host
    /** @type {Map<string, { at: number, mutations: number, value: any }>} */
    this.metadata = new Map()
  }

  /** @param {string} key */
  cached(key) {
    const entry = this.metadata.get(key)
    if (entry === undefined) return undefined
    if (entry.mutations === this.host.mutations && performance.now() - entry.at < METADATA_TTL_MS) return entry
    this.metadata.delete(key)
    return undefined
  }

  /** @param {string} key @param {any} value @param {number} mutations - counter read before the request. */
  remember(key, value, mutations) {
    if (mutations !== this.host.mutations) return
    if (this.metadata.size > 1000) this.metadata.clear()
    this.metadata.set(key, { at: performance.now(), mutations, value })
  }

  /**
   * @param {string} canonicalPath
   */
  target(canonicalPath) {
    return { targetKey: remoteTargetKey(this.host.id, canonicalPath), displayPath: canonicalPath }
  }

  /**
   * Run a helper op; map nonzero exits to FsError.
   * @param {string} op
   * @param {string[]} args
   * @param {string} verb
   * @param {string} displayPath
   * @param {{ input?: string | Buffer, signal?: AbortSignal, allow?: number[] }} [opts]
   */
  async call(op, args, verb, displayPath, opts = {}) {
    let result
    try {
      result = await this.host.helper(op, args, { input: opts.input, signal: opts.signal })
    } catch (error) {
      if (opts.signal?.aborted) throw new FsError(`${verb} "${displayPath}" aborted`, 'FS_ABORTED', { cause: error })
      throw new FsError(`cannot ${verb} "${displayPath}" on ${this.host.id}: ${error instanceof Error ? error.message : String(error)}`, 'FS_IO_ERROR', { cause: error })
    }
    if (result.code === 0 || opts.allow?.includes(result.code ?? -1)) return result
    throw this.failure(result.code, result.stderr, verb, displayPath)
  }

  /**
   * FsError for a failed helper exit.
   * @param {number | null} exit
   * @param {string} stderr
   * @param {string} verb
   * @param {string} displayPath
   */
  failure(exit, stderr, verb, displayPath) {
    const code = EXIT_CODES[/** @type {keyof typeof EXIT_CODES} */ (exit)]
    if (code !== undefined) return new FsError(`cannot ${verb} "${displayPath}": ${MESSAGES[code]}`, code)
    if (exit === 255) {
      return new FsError(`cannot ${verb} "${displayPath}": connection to ${this.host.id} failed: ${stderr.trim()}`, 'FS_IO_ERROR')
    }
    return new FsError(`cannot ${verb} "${displayPath}" on ${this.host.id}: ${stderr.trim() || `exit ${exit}`}`, 'FS_IO_ERROR')
  }

  /**
   * @param {string} absolutePath - already joined with cwd and translated.
   * @param {AbortSignal} [signal]
   */
  async resolve(absolutePath, signal) {
    const hit = this.cached(`r:${absolutePath}`)
    if (hit !== undefined) return this.target(hit.value)
    // One round trip answers the stat that almost always follows.
    const mutations = this.host.mutations
    const result = await this.call('probe', [absolutePath], 'resolve', absolutePath, { signal })
    const output = result.stdout.toString('utf8')
    const eol = output.indexOf('\n')
    const canonical = output.slice(eol + 1).replace(/\n$/, '')
    if (eol < 0 || !canonical.startsWith('/')) throw new FsError(`cannot resolve "${absolutePath}": unexpected helper output`, 'FS_IO_ERROR')
    const line = output.slice(0, eol).trim()
    this.remember(`r:${absolutePath}`, canonical, mutations)
    this.remember(`s:${canonical}`, line === '' ? undefined : statOf(parseStat(line)), mutations)
    return this.target(canonical)
  }

  /** @param {{ displayPath: string }} target @param {AbortSignal} [signal] */
  async stat(target, signal) {
    const hit = this.cached(`s:${target.displayPath}`)
    if (hit !== undefined) return hit.value
    const mutations = this.host.mutations
    const result = await this.call('stat', [target.displayPath], 'stat', target.displayPath, { signal, allow: [10] })
    const stat = result.code === 10 ? undefined : statOf(parseStat(result.stdout.toString('utf8').trim()))
    this.remember(`s:${target.displayPath}`, stat, mutations)
    return stat
  }

  /** @param {string} absolutePath @param {AbortSignal} [signal] */
  async lstat(absolutePath, signal) {
    const result = await this.call('lstat', [absolutePath], 'stat', absolutePath, { signal, allow: [10] })
    if (result.code === 10) return undefined
    const info = parseStat(result.stdout.toString('utf8').trim())
    return { version: info.version, type: info.type, ...info.size !== undefined ? { size: info.size } : {} }
  }

  /** @param {{ displayPath: string }} target @param {AbortSignal} [signal] */
  async readText(target, signal) {
    const bytes = await this.readWhole(target, -1, 'read', signal)
    return decodeText(bytes, 'read', target.displayPath)
  }

  /**
   * @param {{ displayPath: string }} target
   * @param {number} maxBytes
   * @param {'read'|'edit'} verb
   * @param {AbortSignal} [signal]
   */
  async readWhole(target, maxBytes, verb, signal) {
    const result = await this.call('read', [target.displayPath, String(maxBytes)], verb, target.displayPath, { signal })
    const newline = result.stdout.indexOf(10)
    if (newline < 0) throw new FsError(`cannot ${verb} "${target.displayPath}": unexpected helper output`, 'FS_IO_ERROR')
    return result.stdout.subarray(newline + 1)
  }

  /**
   * Stream a remote file: bytes are decoded as they arrive, and a consumer
   * that stops early terminates the transfer.
   * @param {{ displayPath: string }} target
   * @param {AbortSignal} [signal]
   */
  async streamText(target, signal) {
    await this.host.ready()
    signal?.throwIfAborted()
    const path = target.displayPath
    const [cmd, ...args] = this.host.sshArgv(this.host.helperArgv('read', [path, '-1']))
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const closed = new Promise((resolve) => {
      child.on('error', () => resolve(-1))
      child.on('close', code => resolve(code))
    })
    const onAbort = () => child.kill('SIGTERM')
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    const chunks = child.stdout[Symbol.asyncIterator]()
    let head = Buffer.alloc(0)
    try {
      while (head.indexOf(10) < 0) {
        const next = await chunks.next()
        if (next.done) break
        head = Buffer.concat([head, next.value])
      }
    } catch (error) {
      cleanup()
      throw error
    }
    const newline = head.indexOf(10)
    if (newline < 0) {
      const exit = /** @type {number | null} */ (await closed)
      cleanup()
      if (signal?.aborted) throw new FsError(`read "${path}" aborted`, 'FS_ABORTED')
      throw this.failure(exit === 0 ? -1 : exit, stderr, 'read', path)
    }
    const fs = this
    const first = head.subarray(newline + 1)
    return (async function* () {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let sampled = 0
      const decode = (chunk) => {
        if (sampled < BINARY_SAMPLE_BYTES) {
          const part = chunk.subarray(0, BINARY_SAMPLE_BYTES - sampled)
          if (part.includes(0)) throw new FsError(`cannot read "${path}": binary file`, 'FS_NOT_TEXT')
          sampled += part.length
        }
        try {
          return decoder.decode(chunk, { stream: true })
        } catch (error) {
          if (!(error instanceof TypeError)) throw error
          throw new FsError(`cannot read "${path}": invalid UTF-8 text`, 'FS_NOT_TEXT')
        }
      }
      try {
        if (first.length > 0) {
          const text = decode(first)
          if (text !== '') yield text
        }
        for (;;) {
          const next = await chunks.next()
          if (next.done) break
          const text = decode(next.value)
          if (text !== '') yield text
        }
        let tail
        try {
          tail = decoder.decode()
        } catch {
          throw new FsError(`cannot read "${path}": invalid UTF-8 text`, 'FS_NOT_TEXT')
        }
        if (tail !== '') yield tail
        const exit = /** @type {number | null} */ (await closed)
        if (signal?.aborted) throw new FsError(`read "${path}" aborted`, 'FS_ABORTED')
        if (exit !== 0) throw fs.failure(exit, stderr, 'read', path)
      } finally {
        cleanup()
      }
    })()
  }

  /**
   * @param {{ displayPath: string }} target
   * @param {AbortSignal | undefined} signal
   * @param {number} maxBytes
   */
  async readBytes(target, signal, maxBytes) {
    return new Uint8Array(await this.readWhole(target, maxBytes, 'read', signal))
  }

  /**
   * @param {{ displayPath: string }} target
   * @param {{ offset: number, length: number }} range
   * @param {AbortSignal} [signal]
   */
  async readByteRange(target, range, signal) {
    const result = await this.call('range', [target.displayPath, String(range.offset), String(range.length)], 'read', target.displayPath, { signal })
    return new Uint8Array(result.stdout)
  }

  /** @param {{ displayPath: string }} target @param {AbortSignal} [signal] */
  async listDir(target, signal) {
    const dir = target.displayPath
    const result = await this.call('list', [dir], 'list', dir, { signal })
    /** @type {Map<string, any>} */
    const entries = new Map()
    /** @type {Map<string, string>} */
    const links = new Map()
    for (const line of result.stdout.toString('utf8').split('\n')) {
      if (line === '') continue
      if (line.startsWith('L|')) {
        // "L|<canonical target>|<name>"; names never contain "/".
        const rest = line.slice(2)
        const sep = rest.lastIndexOf('|')
        if (sep > 0) links.set(rest.slice(sep + 1), rest.slice(0, sep))
        continue
      }
      if (line.startsWith('D|0|-|')) {
        const name = line.slice(6)
        entries.set(name, { name, type: 'other', target: this.target(posix.join(dir, name)) })
        continue
      }
      const a = line.indexOf('|')
      const b = line.indexOf('|', a + 1)
      const c = line.indexOf('|', b + 1)
      if (a < 0 || b < 0 || c < 0) continue
      const raw = line.slice(c + 1)
      const name = raw.startsWith('./') ? raw.slice(2) : raw
      if (name === '.' || name === '..' || name.includes('/')) continue
      const info = parseStat(line.slice(0, c))
      const type = info.type === 'symlink' ? 'other' : info.type
      entries.set(name, {
        name,
        type,
        target: this.target(posix.join(dir, name)),
        version: info.version,
        ...type === 'file' && info.size !== undefined ? { size: info.size } : {},
      })
    }
    for (const [name, canonical] of links) {
      const entry = entries.get(name)
      if (entry !== undefined) entry.target = this.target(canonical)
    }
    return [...entries.values()].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
  }

  /**
   * Read the version and, when small enough, the current content.
   * @param {string} path
   * @param {number} maxBasisBytes
   * @param {AbortSignal} [signal]
   */
  async readVersioned(path, maxBasisBytes, signal) {
    const result = await this.call('readv', [path, String(maxBasisBytes)], 'read', path, { signal })
    const newline = result.stdout.indexOf(10)
    const header = result.stdout.subarray(0, newline < 0 ? undefined : newline).toString('utf8')
    if (header === 'absent') return { present: false }
    if (!header.startsWith('present|')) throw new FsError(`cannot read "${path}": unexpected helper output`, 'FS_IO_ERROR')
    const info = parseStat(header.slice('present|'.length))
    const body = newline < 0 ? Buffer.alloc(0) : result.stdout.subarray(newline + 1)
    const complete = info.type === 'file' && info.size !== undefined && body.length === info.size && info.size < maxBasisBytes
    return { present: true, type: info.type, version: info.version, body: complete ? body : undefined }
  }

  /**
   * @param {{ displayPath: string }} target
   * @param {string} content
   * @param {{ kind: 'createIfAbsent' } | { kind: 'replaceIfVersion', version: string } | undefined} expected
   * @param {AbortSignal | undefined} signal
   * @param {number} diffBasisMaxBytes
   */
  async writeText(target, content, expected, signal, diffBasisMaxBytes) {
    const path = target.displayPath
    const current = await this.readVersioned(path, diffBasisMaxBytes, signal)
    if (current.present && current.type !== 'file') throw new FsError(`cannot write "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected?.kind === 'createIfAbsent' && current.present) {
      throw new FsError(`cannot write "${path}": file already exists`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion' && (!current.present || current.version !== expected.version)) {
      throw new FsError(`cannot write "${path}": file changed since it was last read`, 'FS_STALE_VERSION')
    }
    let before = null
    if (current.present && current.body !== undefined && !current.body.includes(0)) {
      try {
        before = normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(current.body))
      } catch {
        // Invalid UTF-8 only costs the contextual diff basis.
        before = null
      }
    }
    const expect = expected?.kind === 'createIfAbsent' ? 'absent'
      : expected?.kind === 'replaceIfVersion' ? String(expected.version)
        : '-'
    const result = await this.call('write', [path, expect], 'write', path, { input: content, signal })
    return {
      operation: current.present ? 'update' : 'create',
      version: FsVersion(result.stdout.toString('utf8').trim()),
      before,
      after: normalizeLineEndings(content),
    }
  }

  /**
   * @param {{ displayPath: string }} target
   * @param {{ oldString: string, newString: string, replaceAll: boolean }} edit
   * @param {{ version: string } | undefined} expected
   * @param {AbortSignal} [signal]
   */
  async editText(target, edit, expected, signal) {
    const path = target.displayPath
    const current = await this.readVersioned(path, Number.MAX_SAFE_INTEGER, signal)
    if (!current.present) throw new FsError(`cannot edit "${path}": not found`, 'FS_NOT_FOUND')
    if (current.type !== 'file') throw new FsError(`cannot edit "${path}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && current.version !== expected.version) {
      throw new FsError(`cannot edit "${path}": file changed since it was last read`, 'FS_STALE_VERSION')
    }
    if (current.body === undefined) throw new FsError(`cannot edit "${path}": file changed while reading`, 'FS_STALE_VERSION')
    const raw = decodeText(current.body, 'edit', path)
    const lineEndings = detectLineEndings(raw)
    const before = normalizeLineEndings(raw)
    const oldNorm = normalizeLineEndings(edit.oldString)
    if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
    const newNorm = normalizeLineEndings(edit.newString)
    const replacements = countOccurrences(before, oldNorm)
    if (replacements === 0) throw new FsError(`old_string was not found in "${path}"`, 'FS_EDIT_NOT_FOUND')
    if (!edit.replaceAll && replacements > 1) {
      throw new FsError(`old_string matched ${replacements} times in "${path}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
    }
    const after = before.split(oldNorm).join(newNorm)
    const result = await this.call('write', [path, String(current.version)], 'edit', path, { input: restoreLineEndings(after, lineEndings), signal })
    return { version: FsVersion(result.stdout.toString('utf8').trim()), before, after }
  }
}

/**
 * `file:` URI of a POSIX path.
 * @param {string} path
 */
export function posixFileUrl(path) {
  return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
}
