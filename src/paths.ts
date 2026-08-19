import { isAbsolute, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'

/** Maps the host-only directory accepted by DSH's workspace registry to one remote POSIX tree. */
export class WorkspacePathMapper {
  readonly remoteRoot: string
  readonly anchorRoot: string

  constructor(remoteRoot: string, anchorRoot: string) {
    if (!posix.isAbsolute(remoteRoot)) {
      throw new Error(`dsh-ssh-workspace: root must be an absolute POSIX path: ${JSON.stringify(remoteRoot)}`)
    }
    if (!isAbsolute(anchorRoot)) {
      throw new Error(`dsh-ssh-workspace: anchorRoot must be an absolute host path: ${JSON.stringify(anchorRoot)}`)
    }
    this.remoteRoot = posix.resolve(remoteRoot)
    this.anchorRoot = resolve(anchorRoot)
  }

  /** True when a host path is the anchor root or a child of it. */
  containsAnchor(path: string): boolean {
    const rel = relative(this.anchorRoot, resolve(path))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  /** True when a remote path is the configured root or a child of it. */
  containsRemote(path: string): boolean {
    const rel = posix.relative(this.remoteRoot, posix.resolve(path))
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel))
  }

  /** Convert a host anchor or remote absolute path into a normalized remote path. */
  toRemote(path: string, cwd?: string): string {
    let remote: string
    if (this.containsAnchor(path)) {
      const rel = relative(this.anchorRoot, resolve(path)).split(sep).join('/')
      remote = posix.resolve(this.remoteRoot, rel)
    } else if (posix.isAbsolute(path)) {
      remote = posix.resolve(path)
    } else {
      const base = cwd === undefined ? this.remoteRoot : this.toRemote(cwd)
      remote = posix.resolve(base, path)
    }
    if (!this.containsRemote(remote)) {
      throw new Error(
        `dsh-ssh-workspace: path ${JSON.stringify(remote)} is outside configured root ${JSON.stringify(this.remoteRoot)}`,
      )
    }
    return remote
  }

  /** Convert a remote path into the deterministic local directory registered as a DSH workspace. */
  toAnchor(path: string): string {
    const remote = this.toRemote(path)
    const rel = posix.relative(this.remoteRoot, remote)
    return resolve(this.anchorRoot, ...rel.split('/').filter(Boolean))
  }
}
