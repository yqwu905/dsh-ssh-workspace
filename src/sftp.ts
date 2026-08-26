import type { FileEntry, SFTPWrapper, Stats, WriteFileOptions } from 'ssh2'

type SftpError = Error & { code?: number | string }

function outcome<T>(resolve: (value: T) => void, reject: (reason?: unknown) => void) {
  return (error: Error | null | undefined, value: T): void => error == null ? resolve(value) : reject(error)
}

export function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => sftp.realpath(path, outcome(resolve, reject)))
}

export function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.stat(path, outcome(resolve, reject)))
}

export function sftpLstat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => sftp.lstat(path, outcome(resolve, reject)))
}

export function sftpReadDir(sftp: SFTPWrapper, path: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) => sftp.readdir(path, outcome(resolve, reject)))
}

export function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (error, data) => error === undefined ? resolve(data) : reject(error))
  })
}

export function sftpWriteFile(
  sftp: SFTPWrapper,
  path: string,
  content: string | Buffer,
  options?: WriteFileOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error | null): void => error == null ? resolve() : reject(error)
    if (options === undefined) sftp.writeFile(path, content, done)
    else sftp.writeFile(path, content, options, done)
  })
}

export function sftpMkdir(sftp: SFTPWrapper, path: string, mode = 0o700): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, { mode }, error => error === undefined ? resolve() : reject(error))
  })
}

export function sftpChmod(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(path, mode, error => error === undefined ? resolve() : reject(error))
  })
}

export function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, error => error === undefined ? resolve() : reject(error))
  })
}

/** Rename a newly created internal file without requiring an overwrite extension. */
export function sftpMove(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, error => error === undefined ? resolve() : reject(error))
  })
}

export function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const extension = sftp.ext_openssh_rename?.bind(sftp)
    if (extension === undefined) {
      reject(new Error('SSH server does not support the OpenSSH posix-rename extension required for atomic replace'))
      return
    }
    extension(from, to, error => error === undefined ? resolve() : reject(error))
  })
}

export function sftpHardlink(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const extension = sftp.ext_openssh_hardlink?.bind(sftp)
    if (extension === undefined) {
      reject(new Error('SSH server does not support the OpenSSH hardlink extension required for atomic create'))
      return
    }
    extension(from, to, error => error === undefined ? resolve() : reject(error))
  })
}

export function sftpCode(error: unknown): number | string | undefined {
  return (error as SftpError | undefined)?.code
}
