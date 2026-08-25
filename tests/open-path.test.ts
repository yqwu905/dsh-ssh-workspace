import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { SFTPWrapper, Stats } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshServerRuntime } from '../src/index.js'
import SshOpenPath from '../src/open-path.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SSH native path opening', () => {
  it('downloads a remote file as a read-only host snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-open-'))
    roots.push(root)
    const anchorRoot = join(root, 'anchors', 'alpha')
    await mkdir(anchorRoot, { recursive: true })
    const server = new SshServerRuntime(new Context(), {
      id: 'alpha',
      name: 'Alpha',
      host: 'example.test',
      port: 22,
      username: 'tester',
      root: '/srv',
      anchorRoot,
      authMode: 'auto',
      workspaces: [],
      acceptUnknownHostKey: true,
      readyTimeoutMs: 20_000,
      keepaliveIntervalMs: 10_000,
      keepaliveCountMax: 3,
    })
    const attrs = {
      isDirectory: () => false,
      isFile: () => true,
    } as Stats
    const sftp = {
      realpath: (path: string, callback: (error: Error | undefined, canonical: string) => void) => {
        callback(undefined, path)
      },
      stat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => {
        callback(undefined, attrs)
      },
      createReadStream: () => Readable.from([Buffer.from('remote source\n')]),
    } as unknown as SFTPWrapper
    vi.spyOn(server, 'getSftp').mockResolvedValue(sftp)

    const snapshot = await server.materializeOpenPath('/srv/project/train.py')

    expect(snapshot).toBe(join(root, 'anchors', '.open-cache', 'alpha', 'project', 'train.py'))
    await expect(readFile(snapshot, 'utf8')).resolves.toBe('remote source\n')
    expect((await stat(snapshot)).mode & 0o777).toBe(0o400)
  })

  it('rewrites only SSH anchor opens and restores the host opener on dispose', async () => {
    const rpcId = RpcId('open-1')
    const original = vi.fn(async (request: { rpcId: typeof rpcId; payload: { path: string } }) => ({
      rpcId: request.rpcId,
      result: { ok: true as const, value: { opened: true as const } },
    }))
    const materializeOpenPath = vi.fn(async () => '/tmp/ssh-preview/train.py')
    const server = { materializeOpenPath }
    const runtime = {
      resolveAnchoredPath: (path: string) => path.startsWith('/anchors/alpha/')
        ? { server, remotePath: '/srv/project/train.py' }
        : undefined,
    }
    const apiProxy = { host: { openPath: original } }
    const ctx = new Context()
    ctx.provide('sshWorkspace', runtime as never)
    ctx.provide('apiProxy', apiProxy as never)
    const fiber = await ctx.plugin(SshOpenPath)
    const signal = new AbortController().signal

    await expect(ctx.apiProxy.host.openPath({
      rpcId,
      payload: { path: '/anchors/alpha/project/train.py' },
    }, signal)).resolves.toMatchObject({ result: { ok: true } })
    expect(materializeOpenPath).toHaveBeenCalledWith('/srv/project/train.py', signal)
    expect(original).toHaveBeenLastCalledWith({
      rpcId,
      payload: { path: '/tmp/ssh-preview/train.py' },
    }, signal)

    await ctx.apiProxy.host.openPath({ rpcId, payload: { path: '/tmp/local.txt' } }, signal)
    expect(original).toHaveBeenLastCalledWith({ rpcId, payload: { path: '/tmp/local.txt' } }, signal)

    await fiber.dispose()
    expect(ctx.apiProxy.host.openPath).toBe(original)
  })
})
