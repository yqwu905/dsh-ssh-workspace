import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SshServerRuntime } from '../src/index.js'

function runtime(): SshServerRuntime {
  return new SshServerRuntime({} as Context, {
    id: 'alpha',
    name: 'Alpha',
    host: 'ssh.example.test',
    port: 22,
    username: 'dev',
    root: '/srv/projects',
    anchorRoot: '/tmp/dsh-ssh-anchors/alpha',
    authMode: 'key',
    workspaces: [],
    acceptUnknownHostKey: true,
    readyTimeoutMs: 20_000,
    keepaliveIntervalMs: 10_000,
    keepaliveCountMax: 3,
  })
}

describe('host tool argv adaptation', () => {
  it('maps packaged ripgrep and anchor arguments into the remote execution world', async () => {
    const server = runtime()
    vi.spyOn(server, 'resolveExecutable').mockResolvedValue('/usr/bin/rg')
    await expect(server.adaptArgv([
      '/private/tmp/tooling/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
      '--files',
      '/tmp/dsh-ssh-anchors/alpha/api',
    ])).resolves.toEqual(['/usr/bin/rg', '--files', '/srv/projects/api'])
  })

  it('adds cwd as the target for grep when DSH omitted a path', async () => {
    const server = runtime()
    vi.spyOn(server, 'resolveExecutable').mockResolvedValue('/usr/bin/rg')
    await expect(server.adaptArgv([
      '/private/tmp/tooling/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
      '--no-config',
      '--json',
      '--regexp=DSH_SSH_KEY_E2E_OK',
    ])).resolves.toEqual([
      '/usr/bin/rg',
      '--no-config',
      '--json',
      '--regexp=DSH_SSH_KEY_E2E_OK',
      '--',
      '.',
    ])
  })

  it('keeps an explicit grep target after mapping it to the server', async () => {
    const server = runtime()
    vi.spyOn(server, 'resolveExecutable').mockResolvedValue('/usr/bin/rg')
    await expect(server.adaptArgv([
      '/private/tmp/tooling/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg',
      '--json',
      '--regexp=needle',
      '--',
      '/tmp/dsh-ssh-anchors/alpha/api',
    ])).resolves.toEqual([
      '/usr/bin/rg',
      '--json',
      '--regexp=needle',
      '--',
      '/srv/projects/api',
    ])
  })

  it('leaves ordinary remote commands untouched', async () => {
    const server = runtime()
    await expect(server.adaptArgv(['/bin/sh', '-c', 'pwd'])).resolves.toEqual(['/bin/sh', '-c', 'pwd'])
  })
})
