import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SshDirectoryPicker from '../src/directory-picker.js'
import SshFileSystem from '../src/fs.js'
import { WorkspacePathMapper } from '../src/paths.js'
import SshSubprocessRuntime from '../src/subprocess.js'

function fakeRuntime() {
  return {
    paths: new WorkspacePathMapper('/srv/projects', '/tmp/dsh-ssh-smoke'),
    config: { workspaces: [] },
  }
}

describe('Cordis provider composition', () => {
  it('registers filesystem and subprocess providers over one SSH runtime seam', async () => {
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime() as never)
    const fsFiber = await ctx.plugin(SshFileSystem)
    const processFiber = await ctx.plugin(SshSubprocessRuntime)
    expect(ctx.fs).toBeInstanceOf(SshFileSystem)
    expect(ctx.subprocess).toBeInstanceOf(SshSubprocessRuntime)
    await processFiber.dispose()
    await fsFiber.dispose()
    expect(ctx.get('subprocess')).toBeUndefined()
    expect(ctx.get('fs')).toBeUndefined()
  })

  it('registers the remote browse directory picker', async () => {
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime() as never)
    const fiber = await ctx.plugin(SshDirectoryPicker, { maxEntries: 10 })
    expect(ctx.directoryPicker.capability().kind).toBe('browse')
    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })
})
