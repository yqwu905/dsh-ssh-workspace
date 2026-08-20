import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SshDirectoryPicker from '../src/directory-picker.js'
import SshFileSystem from '../src/fs.js'
import { WorkspacePathMapper } from '../src/paths.js'
import SshSubprocessRuntime from '../src/subprocess.js'

function fakeRuntime() {
  const paths = new WorkspacePathMapper('/srv/projects', '/tmp/dsh-ssh-smoke/alpha')
  const server = {
    paths,
    config: { id: 'alpha', name: 'Alpha', workspaces: [] },
  }
  return {
    anchorRoot: '/tmp/dsh-ssh-smoke',
    listServers: () => [server],
    resolveAnchoredPath: () => undefined,
    resolveAnchor: () => { throw new Error('not an SSH anchor') },
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

  it('keeps local filesystem and subprocess execution available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-local-smoke-'))
    await writeFile(join(root, 'local.txt'), 'local workspace')
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime() as never)
    const fsFiber = await ctx.plugin(SshFileSystem)
    const processFiber = await ctx.plugin(SshSubprocessRuntime)
    try {
      const target = await ctx.fs.resolve('local.txt', { cwd: root })
      await expect(ctx.fs.readText(target)).resolves.toBe('local workspace')
      expect(ctx.fs.processPath(target)).toBe(join(root, 'local.txt'))
      await ctx.fs.writeText(target, 'updated locally')
      await expect(ctx.fs.readText(target)).resolves.toBe('updated locally')

      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())'],
        cwd: root,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 1000,
      })
      await expect(handle.done).resolves.toMatchObject({ exitCode: 0, signal: null })
      expect(handle.collected.stdout?.readFrom(0).text).toBe(root)
    } finally {
      await processFiber.dispose()
      await fsFiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('registers the remote browse directory picker', async () => {
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime() as never)
    const fiber = await ctx.plugin(SshDirectoryPicker, { maxEntries: 10 })
    expect(ctx.directoryPicker.capability().kind).toBe('browse')
    await fiber.dispose()
    expect(ctx.get('directoryPicker')).toBeUndefined()
  })

  it('offers local and SSH roots from one directory picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-picker-smoke-'))
    await mkdir(join(root, 'project'))
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime() as never)
    const fiber = await ctx.plugin(SshDirectoryPicker, { maxEntries: 10 })
    try {
      const capability = ctx.directoryPicker.capability()
      expect(capability.kind).toBe('browse')
      if (capability.kind !== 'browse') throw new Error('expected browse directory picker')
      await expect(capability.list()).resolves.toMatchObject({
        path: '/tmp/dsh-ssh-smoke',
        entries: [
          { name: 'Local filesystem', path: homedir() },
          { name: 'Alpha', path: '/tmp/dsh-ssh-smoke/alpha' },
        ],
      })
      const local = await capability.list(root)
      expect(local.home).toBe('/tmp/dsh-ssh-smoke')
      expect(local.crumbs[0]).toMatchObject({ name: 'Workspaces', path: '/tmp/dsh-ssh-smoke' })
      expect(local.entries).toEqual([
        { name: 'project', path: join(root, 'project'), hidden: false },
      ])
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
