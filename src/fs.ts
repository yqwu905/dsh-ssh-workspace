import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import {
  FsError,
  FsTargetKey,
  FsVersion,
} from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { writableRoots } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Attributes, SFTPWrapper, Stats } from 'ssh2'
import { decodeSshTarget, encodeSshTarget } from './index.js'
import type { SshServerRuntime } from './index.js'
import {
  sftpChmod,
  sftpCode,
  sftpHardlink,
  sftpLstat,
  sftpMkdir,
  sftpReadDir,
  sftpReadFile,
  sftpRealpath,
  sftpRename,
  sftpStat,
  sftpUnlink,
  sftpWriteFile,
} from './sftp.js'

const BINARY_SAMPLE_BYTES = 8192
const DIFF_BASIS_MAX_BYTES = 4 * 1024 * 1024

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted === true) throw new FsError(`${operation} aborted`, 'FS_ABORTED')
}

function notFound(error: unknown): boolean {
  const code = sftpCode(error)
  return code === 2 || code === 'ENOENT'
}

function mapError(error: unknown, operation: string, path: string, signal?: AbortSignal): FsError {
  if (error instanceof FsError) return error
  if (signal?.aborted === true || (error instanceof DOMException && error.name === 'AbortError')) {
    return new FsError(`${operation} aborted`, 'FS_ABORTED', { cause: error })
  }
  const code = sftpCode(error)
  if (code === 2 || code === 'ENOENT') {
    return new FsError(`cannot ${operation} "${path}": not found`, 'FS_NOT_FOUND', { cause: error })
  }
  if (code === 3 || code === 'EACCES' || code === 'EPERM' || /permission denied/iu.test(String(error))) {
    return new FsError(`cannot ${operation} "${path}": permission denied`, 'FS_PERMISSION_DENIED', { cause: error })
  }
  return new FsError(`cannot ${operation} "${path}": ${String(error)}`, 'FS_IO_ERROR', { cause: error })
}

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function attributesType(attrs: Attributes): 'file' | 'directory' | 'symlink' | 'other' {
  const kind = attrs.mode & S_IFMT
  return kind === S_IFREG ? 'file' : kind === S_IFDIR ? 'directory' : kind === S_IFLNK ? 'symlink' : 'other'
}

function version(path: string, attrs: Attributes): ReturnType<typeof FsVersion> {
  const facts = JSON.stringify([
    path,
    attrs.size,
    attrs.mode,
    attrs.uid,
    attrs.gid,
    attrs.atime,
    attrs.mtime,
  ])
  return FsVersion(`ssh:${createHash('sha256').update(facts).digest('hex')}`)
}

function info(path: string, attrs: Stats): FsInfo {
  return {
    version: version(path, attrs),
    type: attrs.isFile() ? 'file' : attrs.isDirectory() ? 'directory' : 'other',
    ...(attrs.isFile() ? { size: attrs.size } : {}),
  }
}

function decodeText(bytes: Uint8Array, displayPath: string): string {
  if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error: unknown) {
    throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
  }
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n')
}

function detectsCrlf(value: string): boolean {
  const sample = value.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  const lf = sample.split('\n').length - 1 - crlf
  return crlf > lf
}

function literalEdit(content: string, request: FsEditRequest, displayPath: string): string {
  const oldString = normalizeLineEndings(request.oldString)
  const newString = normalizeLineEndings(request.newString)
  if (oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": old_string must be non-empty`, 'FS_EDIT_NOT_FOUND')
  }
  let count = 0
  let from = 0
  while (true) {
    const found = content.indexOf(oldString, from)
    if (found < 0) break
    count += 1
    from = found + oldString.length
  }
  if (count === 0) throw new FsError(`cannot edit "${displayPath}": old_string was not found`, 'FS_EDIT_NOT_FOUND')
  if (!request.replaceAll && count !== 1) {
    throw new FsError(`cannot edit "${displayPath}": old_string matched ${count} times`, 'FS_AMBIGUOUS_EDIT')
  }
  return request.replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString)
}

async function maybeStat(sftp: SFTPWrapper, path: string): Promise<Stats | undefined> {
  try {
    return await sftpStat(sftp, path)
  } catch (error: unknown) {
    if (notFound(error)) return undefined
    throw error
  }
}

async function mkdirp(sftp: SFTPWrapper, path: string): Promise<void> {
  const missing: string[] = []
  let current = path
  while (current !== '/') {
    try {
      const attrs = await sftpStat(sftp, current)
      if (!attrs.isDirectory()) throw new Error(`remote parent is not a directory: ${current}`)
      break
    } catch (error: unknown) {
      if (!notFound(error)) throw error
      missing.push(current)
      current = posix.dirname(current)
    }
  }
  for (const directory of missing.reverse()) await sftpMkdir(sftp, directory)
}

/** Route SSH anchor targets through SFTP and every other target through the host filesystem. */
export class SshFileSystem extends LocalFileSystem {
  static inject = ['sshWorkspace', 'sandboxPolicy']

  private readonly remoteLocks = new Map<string, Promise<unknown>>()

  /** Advertise the same policy capability as DSH's sandboxed local filesystem. */
  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    assertNotAborted(opts?.signal, 'resolve')
    if (path.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
    const routed = this.ctx.sshWorkspace.resolveAnchoredPath(path, opts?.cwd)
    if (routed === undefined) return await super.resolve(path, opts)
    let displayPath: string
    try {
      displayPath = routed.remotePath
      const targetPath = await this.canonicalPath(await routed.server.getSftp(), displayPath, opts?.signal)
      if (!routed.server.paths.containsRemote(targetPath)) {
        throw new FsError(
          `cannot resolve "${displayPath}": symbolic link escapes configured SSH root`,
          'FS_PERMISSION_DENIED',
        )
      }
      return { targetKey: FsTargetKey(encodeSshTarget(routed.server.config.id, targetPath)), displayPath }
    } catch (error: unknown) {
      displayPath ??= path
      throw mapError(error, 'resolve', displayPath, opts?.signal)
    }
  }

  override processPath(target: FsTarget): string {
    return this.remoteTarget(target)?.remotePath ?? super.processPath(target)
  }

  override fileUrl(target: FsTarget): string {
    const remote = this.remoteTarget(target)
    if (remote === undefined) return super.fileUrl(target)
    const path = remote.remotePath
    return `file://${path.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const left = this.remoteTarget(parent)
    const right = this.remoteTarget(child)
    if (left === undefined && right === undefined) return super.contains(parent, child)
    if (left === undefined || right === undefined) return false
    if (left.server.config.id !== right.server.config.id) return false
    const rel = posix.relative(left.remotePath, right.remotePath)
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const routed = this.remoteTarget(target)
    if (routed === undefined) return await super.stat(target, signal)
    assertNotAborted(signal, 'stat')
    try {
      const attrs = await maybeStat(await routed.server.getSftp(), routed.remotePath)
      assertNotAborted(signal, 'stat')
      return attrs === undefined ? undefined : info(String(target.targetKey), attrs)
    } catch (error: unknown) {
      throw mapError(error, 'stat', target.displayPath, signal)
    }
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const routed = this.ctx.sshWorkspace.resolveAnchoredPath(path, opts?.cwd)
    if (routed === undefined) return await super.lstat(path, opts, signal)
    assertNotAborted(signal, 'lstat')
    const remote = routed.remotePath
    try {
      const attrs = await sftpLstat(await routed.server.getSftp(), remote)
      assertNotAborted(signal, 'lstat')
      return {
        version: version(encodeSshTarget(routed.server.config.id, remote), attrs),
        type: attrs.isSymbolicLink() ? 'symlink' : attrs.isFile() ? 'file' : attrs.isDirectory() ? 'directory' : 'other',
        ...(attrs.isFile() ? { size: attrs.size } : {}),
      }
    } catch (error: unknown) {
      if (notFound(error)) return undefined
      throw mapError(error, 'lstat', remote, signal)
    }
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const routed = this.remoteTarget(target)
    if (routed === undefined) return await super.readText(target, signal)
    assertNotAborted(signal, 'read')
    const current = await this.stat(target, signal)
    if (current === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (current.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    try {
      const bytes = await sftpReadFile(await routed.server.getSftp(), routed.remotePath)
      assertNotAborted(signal, 'read')
      return decodeText(bytes, target.displayPath)
    } catch (error: unknown) {
      throw mapError(error, 'read', target.displayPath, signal)
    }
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const routed = this.remoteTarget(target)
    if (routed === undefined) return await super.readBytes(target, signal, maxBytes)
    const current = await this.stat(target, signal)
    if (current === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (current.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (current.size !== undefined && current.size > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": ${current.size} bytes exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    const bytes = await sftpReadFile(await routed.server.getSftp(), routed.remotePath)
    assertNotAborted(signal, 'read')
    if (bytes.length > maxBytes) {
      throw new FsError(`cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`, 'FS_TOO_LARGE')
    }
    return bytes
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const routed = this.remoteTarget(target)
    if (routed === undefined) return await super.streamText(target, signal)
    const current = await this.stat(target, signal)
    if (current === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (current.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const sftp = await routed.server.getSftp()
    const stream = sftp.createReadStream(routed.remotePath) as Readable
    const displayPath = target.displayPath
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let sampled = 0
        const onAbort = (): void => { stream.destroy(new FsError('read aborted', 'FS_ABORTED')) }
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          for await (const raw of stream) {
            assertNotAborted(signal, 'read')
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
            if (sampled < BINARY_SAMPLE_BYTES) {
              const sample = chunk.subarray(0, BINARY_SAMPLE_BYTES - sampled)
              if (sample.includes(0)) throw new FsError(`cannot read "${displayPath}": binary file`, 'FS_NOT_TEXT')
              sampled += sample.length
            }
            let text: string
            try {
              text = decoder.decode(chunk, { stream: true })
            } catch (error: unknown) {
              throw new FsError(`cannot read "${displayPath}": invalid UTF-8 text`, 'FS_NOT_TEXT', { cause: error })
            }
            if (text.length > 0) yield text
          }
          const final = decoder.decode()
          if (final.length > 0) yield final
        } catch (error: unknown) {
          throw mapError(error, 'read', displayPath, signal)
        } finally {
          signal?.removeEventListener('abort', onAbort)
          if (!stream.destroyed) stream.destroy()
        }
      },
    }
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const routed = this.remoteTarget(target)
    if (routed === undefined) return await super.listDir(target, signal)
    const current = await this.stat(target, signal)
    if (current === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (current.type !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    try {
      const sftp = await routed.server.getSftp()
      const rows = await sftpReadDir(sftp, routed.remotePath)
      const entries: FsDirEntry[] = []
      for (const row of rows.sort((left, right) => left.filename.localeCompare(right.filename))) {
        assertNotAborted(signal, 'list')
        const childDisplay = posix.join(target.displayPath, row.filename)
        const childPath = await this.canonicalPath(sftp, posix.join(routed.remotePath, row.filename), signal)
        const listedType = attributesType(row.attrs)
        const childAttrs: Attributes = listedType === 'symlink' ? await sftpStat(sftp, childPath) : row.attrs
        const childType = attributesType(childAttrs)
        entries.push({
          name: row.filename,
          type: childType === 'file' ? 'file' : childType === 'directory' ? 'directory' : 'other',
          target: {
            targetKey: FsTargetKey(encodeSshTarget(routed.server.config.id, childPath)),
            displayPath: childDisplay,
          },
          version: version(encodeSshTarget(routed.server.config.id, childPath), childAttrs),
          ...(childType === 'file' ? { size: childAttrs.size } : {}),
        })
      }
      return entries
    } catch (error: unknown) {
      throw mapError(error, 'list', target.displayPath, signal)
    }
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const checked = await this.checkedTarget(target, sandboxPolicy)
    const routed = this.remoteTarget(checked)
    if (routed === undefined) return await super.writeText(checked, content, expected, signal)
    return await this.withRemoteLock(String(target.targetKey), async () => {
      const sftp = await routed.server.getSftp()
      const path = routed.remotePath
      const existing = await maybeStat(sftp, path)
      if (existing !== undefined && !existing.isFile()) {
        throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
        throw new FsError(`cannot write "${target.displayPath}": target already exists`, 'FS_NOT_OBSERVED')
      }
      if (expected?.kind === 'replaceIfVersion'
        && (existing === undefined || version(String(target.targetKey), existing) !== expected.version)) {
        throw new FsError(`cannot write "${target.displayPath}": observed version is stale`, 'FS_STALE_VERSION')
      }
      assertNotAborted(signal, 'write')
      const before = existing === undefined ? null : await this.diffBasis(sftp, path, existing, target.displayPath)
      const next = await this.atomicWrite(sftp, path, content, existing, expected?.kind === 'createIfAbsent', signal)
      return {
        operation: existing === undefined ? 'create' : 'update',
        version: version(String(target.targetKey), next),
        before,
        after: normalizeLineEndings(content),
      }
    })
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof FsVersion> },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    const checked = await this.checkedTarget(target, sandboxPolicy)
    const routed = this.remoteTarget(checked)
    if (routed === undefined) return await super.editText(checked, edit, expected, signal)
    return await this.withRemoteLock(String(target.targetKey), async () => {
      const sftp = await routed.server.getSftp()
      const path = routed.remotePath
      const attrs = await maybeStat(sftp, path)
      if (attrs === undefined) throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      if (!attrs.isFile()) throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      if (expected !== undefined && version(String(target.targetKey), attrs) !== expected.version) {
        throw new FsError(`cannot edit "${target.displayPath}": observed version is stale`, 'FS_STALE_VERSION')
      }
      const raw = decodeText(await sftpReadFile(sftp, path), target.displayPath)
      const crlf = detectsCrlf(raw)
      const before = normalizeLineEndings(raw)
      const after = literalEdit(before, edit, target.displayPath)
      assertNotAborted(signal, 'edit')
      const storage = crlf ? after.replaceAll('\n', '\r\n') : after
      const next = await this.atomicWrite(sftp, path, storage, attrs, false, signal)
      return { version: version(String(target.targetKey), next), before, after }
    })
  }

  private async canonicalPath(sftp: SFTPWrapper, path: string, signal?: AbortSignal): Promise<string> {
    const missing: string[] = []
    let current = path
    for (;;) {
      assertNotAborted(signal, 'resolve')
      try {
        const canonical = await sftpRealpath(sftp, current)
        return posix.resolve(canonical, ...missing.reverse())
      } catch (error: unknown) {
        if (!notFound(error)) throw error
        const parent = posix.dirname(current)
        if (parent === current) throw error
        missing.push(posix.basename(current))
        current = parent
      }
    }
  }

  private async checkedTarget(
    target: FsTarget,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsTarget> {
    const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    if (policy.mode === 'danger-full-access') return target
    if (policy.mode === 'read-only') {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under read-only mode`,
        'FS_SANDBOX_DENIED',
      )
    }

    const fresh = await this.refreshTarget(target)
    const remote = this.remoteTarget(fresh)
    if (remote !== undefined) {
      const workspace = this.ctx.sshWorkspace.resolveAnchoredPath(policy.workspaceRoot)
      const relative = workspace === undefined || workspace.server !== remote.server
        ? '..'
        : posix.relative(workspace.remotePath, remote.remotePath)
      const contained = relative === ''
        || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative))
      if (contained) return fresh
    } else {
      for (const root of writableRoots({ ...policy, mode: 'workspace-write' })) {
        const rootTarget = await this.resolve(root)
        if (this.contains(rootTarget, fresh)) return fresh
      }
    }

    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      'FS_SANDBOX_DENIED',
    )
  }

  private async refreshTarget(target: FsTarget): Promise<FsTarget> {
    const remote = this.remoteTarget(target)
    if (remote === undefined) return await this.resolve(target.displayPath)
    const canonical = await this.canonicalPath(await remote.server.getSftp(), remote.remotePath)
    if (!remote.server.paths.containsRemote(canonical)) {
      throw new FsError(
        `cannot resolve "${target.displayPath}": symbolic link escapes configured SSH root`,
        'FS_PERMISSION_DENIED',
      )
    }
    return {
      targetKey: FsTargetKey(encodeSshTarget(remote.server.config.id, canonical)),
      displayPath: target.displayPath,
    }
  }

  private remoteTarget(target: FsTarget): { server: SshServerRuntime; remotePath: string } | undefined {
    const key = String(target.targetKey)
    if (!key.startsWith('dsh-ssh:')) return undefined
    const decoded = decodeSshTarget(key)
    return { server: this.ctx.sshWorkspace.getServer(decoded.serverId), remotePath: decoded.remotePath }
  }

  private async diffBasis(sftp: SFTPWrapper, path: string, attrs: Stats, displayPath: string): Promise<string | null> {
    if (attrs.size > DIFF_BASIS_MAX_BYTES) return null
    try {
      return normalizeLineEndings(decodeText(await sftpReadFile(sftp, path), displayPath))
    } catch (error: unknown) {
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') return null
      throw error
    }
  }

  private async atomicWrite(
    sftp: SFTPWrapper,
    path: string,
    content: string,
    existing: Stats | undefined,
    noReplace: boolean,
    signal?: AbortSignal,
  ): Promise<Attributes> {
    const parent = posix.dirname(path)
    await mkdirp(sftp, parent)
    const stage = posix.join(parent, `.dsh-ssh-${randomUUID()}.tmp`)
    try {
      await sftpWriteFile(sftp, stage, content, { mode: existing?.mode === undefined ? 0o600 : existing.mode & 0o777 })
      if (existing?.mode !== undefined) await sftpChmod(sftp, stage, existing.mode & 0o777)
      const staged = await sftpStat(sftp, stage)
      assertNotAborted(signal, 'write')
      if (noReplace) {
        try {
          await sftpHardlink(sftp, stage, path)
        } catch (error: unknown) {
          if (await maybeStat(sftp, path) !== undefined) {
            throw new FsError(`cannot create "${path}": target already exists`, 'FS_NOT_OBSERVED', { cause: error })
          }
          throw error
        }
        try {
          await sftpUnlink(sftp, stage)
        } catch {
          // The hardlink is the commit point; stale staging cleanup is best-effort.
        }
      } else {
        await sftpRename(sftp, stage, path)
      }
      return staged
    } catch (error: unknown) {
      try {
        await sftpUnlink(sftp, stage)
      } catch {
        // Best-effort cleanup after the primary failure.
      }
      throw mapError(error, 'write', path, signal)
    }
  }

  private async withRemoteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.remoteLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const slot = new Promise<void>(resolveSlot => { release = resolveSlot })
    const tail = predecessor.catch(() => {}).then(() => slot)
    this.remoteLocks.set(key, tail)
    await predecessor.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.remoteLocks.get(key) === tail) this.remoteLocks.delete(key)
    }
  }
}

export default SshFileSystem
