import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DirectoryPicker,
  DirectoryPickerError,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {
  DirectoryEntry,
  DirectoryListing,
  DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import type {} from './index.js'
import { sftpMkdir, sftpReadDir, sftpRealpath, sftpStat } from './sftp.js'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export interface Config {
  maxEntries?: number
}

interface ResolvedConfig extends Config {
  maxEntries: number
}

/** Remote browse picker whose wire paths are deterministic local workspace anchors. */
export class SshDirectoryPicker extends DirectoryPicker {
  static inject = ['sshWorkspace']

  static Config: z<Config> = z.object({
    maxEntries: z.number().default(1000),
  })

  private readonly config: ResolvedConfig
  private readonly browseCapability: DirectoryPickerCapability = {
    kind: 'browse',
    list: (path, signal) => this.list(path, signal),
    createDirectory: (path, name) => this.createDirectory(path, name),
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    if (!Number.isInteger(this.config.maxEntries) || this.config.maxEntries < 1) {
      throw new Error('dsh-ssh-workspace: directory picker maxEntries must be a positive integer')
    }
  }

  capability(): DirectoryPickerCapability {
    return this.browseCapability
  }

  private async list(path?: string, signal?: AbortSignal): Promise<DirectoryListing> {
    signal?.throwIfAborted()
    let remote: string
    try {
      remote = path === undefined
        ? this.ctx.sshWorkspace.paths.remoteRoot
        : this.ctx.sshWorkspace.paths.toRemote(path)
    } catch (error: unknown) {
      throw new DirectoryPickerError(
        'directory-unreadable',
        path ?? '',
        error instanceof Error ? error.message : String(error),
      )
    }
    try {
      const sftp = await this.ctx.sshWorkspace.getSftp()
      const canonical = await sftpRealpath(sftp, remote)
      if (!this.ctx.sshWorkspace.paths.containsRemote(canonical)) {
        throw new Error(`path resolves outside configured root: ${remote} -> ${canonical}`)
      }
      const targetInfo = await sftpStat(sftp, remote)
      if (!targetInfo.isDirectory()) throw new Error('path is not a directory')
      const rows = await sftpReadDir(sftp, remote)
      const directories: Array<{ name: string; remote: string }> = []
      for (const row of rows.sort((left, right) => left.filename.localeCompare(right.filename))) {
        signal?.throwIfAborted()
        if (directories.length > this.config.maxEntries) break
        const child = posix.join(remote, row.filename)
        const kind = row.attrs.mode & S_IFMT
        let isDirectory = kind === S_IFDIR
        if (kind === S_IFLNK) {
          try {
            const canonicalChild = await sftpRealpath(sftp, child)
            isDirectory = this.ctx.sshWorkspace.paths.containsRemote(canonicalChild)
              && (await sftpStat(sftp, canonicalChild)).isDirectory()
          } catch {
            isDirectory = false
          }
        }
        if (isDirectory) directories.push({ name: row.filename, remote: child })
      }
      const truncated = directories.length > this.config.maxEntries
      if (truncated) directories.length = this.config.maxEntries
      const targetAnchor = await this.ctx.sshWorkspace.materializeAnchor(remote)
      const entries: DirectoryEntry[] = []
      for (const entry of directories) {
        entries.push({
          name: entry.name,
          path: await this.ctx.sshWorkspace.materializeAnchor(entry.remote),
          hidden: entry.name.startsWith('.'),
        })
      }
      return {
        path: targetAnchor,
        home: this.ctx.sshWorkspace.paths.anchorRoot,
        crumbs: await this.crumbs(remote),
        entries,
        truncated,
      }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw signal.reason
      throw new DirectoryPickerError(
        'directory-unreadable',
        path ?? this.ctx.sshWorkspace.paths.anchorRoot,
        `cannot list remote directory "${remote}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async createDirectory(path: string, name: string): Promise<string> {
    if (name.trim().length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
      throw new DirectoryPickerError('directory-create-failed', path, 'directory name must be one non-blank path segment')
    }
    let remote: string
    try {
      const parent = await this.ctx.sshWorkspace.requireRemoteDirectory(path)
      remote = posix.join(parent, name)
      await sftpMkdir(await this.ctx.sshWorkspace.getSftp(), remote)
      return await this.ctx.sshWorkspace.materializeAnchor(remote)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const code = /exist/iu.test(message) ? 'directory-exists' : 'directory-create-failed'
      throw new DirectoryPickerError(code, path, `cannot create remote directory "${name}": ${message}`)
    }
  }

  private async crumbs(remote: string): Promise<DirectoryEntry[]> {
    const root = this.ctx.sshWorkspace.paths.remoteRoot
    const rel = posix.relative(root, remote)
    const segments = rel.length === 0 ? [] : rel.split('/')
    const rows: DirectoryEntry[] = [{
      name: posix.basename(root) || root,
      path: await this.ctx.sshWorkspace.materializeAnchor(root),
      hidden: false,
    }]
    let current = root
    for (const segment of segments) {
      current = posix.join(current, segment)
      rows.push({ name: segment, path: await this.ctx.sshWorkspace.materializeAnchor(current), hidden: false })
    }
    return rows
  }
}

export default SshDirectoryPicker
