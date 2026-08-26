import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SshSandboxProvider, { remoteBwrapArgv } from '../src/sandbox.js'
import { confineRemoteArgv, remoteLandlockArgv, selectRemoteSandbox } from '../src/remote-sandbox.js'

const anchor = '/tmp/dsh-ssh-sandbox/alpha/project'
const remote = '/srv/projects/project'

function fakeRuntime() {
  const server = {
    confineSandbox(argv: readonly string[], policy: Parameters<typeof confineRemoteArgv>[1], remoteRoot: string) {
      return confineRemoteArgv(argv, policy, remoteRoot, { kind: 'bwrap', enforcement: 'full' })
    },
  }
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

  it('builds the equivalent workspace-write Landlock grants', () => {
    expect(remoteLandlockArgv(
      ['bash', '-c', 'touch allowed'],
      { mode: 'workspace-write', workspaceRoot: anchor },
      remote,
      '/home/dev/.cache/dsh-ssh-workspace/landlock-run',
    )).toEqual([
      '/home/dev/.cache/dsh-ssh-workspace/landlock-run',
      '--ro', '/',
      '--rw', '/dev/null',
      '--rw', '/tmp',
      '--rw', remote,
      '--',
      'bash', '-c', 'touch allowed',
    ])
  })

  it('falls back to Landlock after the remote bwrap functional probe fails', async () => {
    const selected = await selectRemoteSandbox(
      async () => ({ usable: false, detail: 'bwrap: No permissions to creating new namespace' }),
      async () => ({
        usable: true,
        backend: {
          kind: 'landlock',
          enforcement: 'full',
          runnerPath: '/home/dev/.cache/dsh-ssh-workspace/landlock-run',
        },
      }),
    )
    expect(selected).toEqual({
      kind: 'landlock',
      enforcement: 'full',
      runnerPath: '/home/dev/.cache/dsh-ssh-workspace/landlock-run',
    })
  })

  it('preserves both remote probe diagnostics when no backend can enforce', async () => {
    const selected = await selectRemoteSandbox(
      async () => ({ usable: false, detail: 'user namespaces disabled' }),
      async () => ({ usable: false, detail: 'Landlock disabled by kernel' }),
    )
    expect(selected).toEqual({
      kind: 'unavailable',
      detail: 'SSH remote bwrap probe failed: user namespaces disabled; Landlock fallback failed: Landlock disabled by kernel',
    })
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
