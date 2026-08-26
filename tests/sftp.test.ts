import type { SFTPWrapper } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { sftpHardlink, sftpMove, sftpRename } from '../src/sftp.js'

describe('atomic SFTP extensions', () => {
  it('refuses to silently downgrade atomic replace', async () => {
    const rename = vi.fn()
    const sftp = { rename } as unknown as SFTPWrapper
    await expect(sftpRename(sftp, '/tmp/stage', '/tmp/target')).rejects.toThrow(/posix-rename/u)
    expect(rename).not.toHaveBeenCalled()
  })

  it('uses the OpenSSH atomic replace extension when available', async () => {
    const extension = vi.fn((_from: string, _to: string, done: (error?: Error) => void) => done())
    const sftp = { ext_openssh_rename: extension } as unknown as SFTPWrapper
    await expect(sftpRename(sftp, '/tmp/stage', '/tmp/target')).resolves.toBeUndefined()
    expect(extension).toHaveBeenCalledWith('/tmp/stage', '/tmp/target', expect.any(Function))
  })

  it('uses standard SFTP rename for a new private cache entry', async () => {
    const rename = vi.fn((_from: string, _to: string, done: (error?: Error) => void) => done())
    const sftp = { rename } as unknown as SFTPWrapper
    await expect(sftpMove(sftp, '/tmp/stage', '/tmp/target')).resolves.toBeUndefined()
    expect(rename).toHaveBeenCalledWith('/tmp/stage', '/tmp/target', expect.any(Function))
  })

  it('requires the OpenSSH hardlink extension for guarded create', async () => {
    await expect(sftpHardlink({} as SFTPWrapper, '/tmp/stage', '/tmp/target')).rejects.toThrow(/hardlink/u)
  })
})
