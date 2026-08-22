import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalPwshSubprocessRuntime from '../src/local-pwsh-subprocess.js'

function fakeRuntime(remoteRoot: string) {
  return {
    resolveAnchoredPath(path: string) {
      const child = path.startsWith(`${remoteRoot}/`) || path.startsWith(`${remoteRoot}\\`)
      if (path !== remoteRoot && !child) return undefined
      return { server: {}, remotePath: '/srv/projects' }
    },
  }
}

describe('local PowerShell subprocess routing', () => {
  it('executes native processes in an ordinary local workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-pwsh-local-'))
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime('/tmp/dsh-ssh-pwsh-remote') as never)
    const fiber = await ctx.plugin(LocalPwshSubprocessRuntime)
    try {
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
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('executes PowerShell on a Windows host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-pwsh-windows-'))
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime(join(tmpdir(), 'dsh-ssh-pwsh-remote')) as never)
    const fiber = await ctx.plugin(LocalPwshSubprocessRuntime)
    try {
      const handle = ctx.subprocess.spawn({
        argv: [
          'pwsh',
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[Console]::Out.Write('pwsh-local-ok')",
        ],
        cwd: root,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 1000,
      })
      await expect(handle.done).resolves.toMatchObject({ exitCode: 0, signal: null })
      expect(handle.collected.stdout?.readFrom(0).text).toBe('pwsh-local-ok')
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects process and terminal execution inside an SSH anchor', async () => {
    const remoteRoot = '/tmp/dsh-ssh-pwsh-remote'
    const ctx = new Context()
    ctx.provide('sshWorkspace', fakeRuntime(remoteRoot) as never)
    const fiber = await ctx.plugin(LocalPwshSubprocessRuntime)
    try {
      expect(() => ctx.subprocess.spawn({
        argv: ['pwsh', '-Command', 'Get-Location'],
        cwd: remoteRoot,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 1000,
      })).toThrow(/PowerShell is available only in local workspaces/u)

      await expect(ctx.subprocess.spawnTerminal({
        argv: ['pwsh'],
        cwd: remoteRoot,
        rows: 24,
        cols: 80,
        graceMs: 1000,
      })).rejects.toThrow(/PowerShell is available only in local workspaces/u)
    } finally {
      await fiber.dispose()
    }
  })
})
