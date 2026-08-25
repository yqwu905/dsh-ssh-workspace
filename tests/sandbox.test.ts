import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SshSandboxProvider, { remoteBwrapArgv } from '../src/sandbox.js'

const anchor = '/tmp/dsh-ssh-sandbox/alpha/project'
const remote = '/srv/projects/project'

function fakeRuntime() {
  const server = {}
  return {
    resolveAnchoredPath(path: string) {
      return path === anchor ? { server, remotePath: remote } : undefined
    },
  }
}

describe('mixed sandbox routing', () => {
  it('builds a remote read-only bubblewrap profile', () => {
    expect(remoteBwrapArgv(
      ['bash', '-c', 'touch denied'],
      { mode: 'read-only', workspaceRoot: anchor },
      remote,
    )).toEqual([
      'bwrap',
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--unshare-pid',
      '--proc', '/proc',
      '--die-with-parent',
      '--',
      'bash', '-c', 'touch denied',
    ])
  })

  it('adds only the remote workspace and private temp as writable roots', () => {
    const argv = remoteBwrapArgv(
      ['bash', '-c', 'touch allowed'],
      { mode: 'workspace-write', workspaceRoot: anchor },
      remote,
    )
    expect(argv).toContain(remote)
    expect(argv).not.toContain(anchor)
    expect(argv).toEqual(expect.arrayContaining(['--tmpfs', '/tmp', '--bind', remote, remote]))
  })

  it('routes SSH policies without consulting a host sandbox runner', async () => {
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime() as never)
    const fiber = await ctx.plugin(SshSandboxProvider)
    try {
      const confined = ctx.sandbox.confine(
        ['bash', '-c', 'printf ok'],
        { mode: 'workspace-write', workspaceRoot: anchor },
      )
      expect(confined.enforcement).toBe('full')
      expect(confined.argv[0]).toBe('bwrap')
      expect(confined.argv).toContain(remote)
      expect(confined.argv).not.toContain(anchor)
      expect(confined.runnerFailureRules).toEqual([{ fatalSignatures: ['bwrap: '] }])
    } finally {
      await fiber.dispose()
    }
  })
})
