import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Server, utils } from 'ssh2'
import { describe, expect, it, vi } from 'vitest'
import { SshWorkspaceRuntime } from '../src/index.js'
import SshFileSystem from '../src/fs.js'
import { hostKeyFingerprint } from '../src/ssh-utils.js'
import { SshSubprocessRuntime } from '../src/subprocess.js'

const liveIt = process.env.DSH_SSH_LOOPBACK === '1' ? it : it.skip

describe('loopback SSH transport', () => {
  liveIt('authenticates, verifies the host key, forwards stdin, and collects remote output', async () => {
    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const hostKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' })
    const parsed = utils.parseKey(hostKey)
    if (parsed instanceof Error) throw parsed

    const server = new Server({ hostKeys: [hostKey] }, (connection) => {
      connection.on('authentication', (auth) => {
        if (auth.method === 'password' && auth.username === 'smoke' && auth.password === 'secret') auth.accept()
        else auth.reject()
      }).on('ready', () => {
        connection.on('session', (accept) => {
          const session = accept()
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp()
            const attrs = {
              mode: constants.S_IFDIR | 0o700,
              uid: process.getuid?.() ?? 0,
              gid: process.getgid?.() ?? 0,
              size: 0,
              atime: Math.floor(Date.now() / 1000),
              mtime: Math.floor(Date.now() / 1000),
            }
            sftp.on('REALPATH', (requestId, path) => {
              sftp.name(requestId, [{ filename: path, longname: path, attrs }])
            }).on('STAT', (requestId) => sftp.attrs(requestId, attrs))
              .on('LSTAT', (requestId) => sftp.attrs(requestId, attrs))
          })
          session.on('exec', (acceptExec, _reject, exec) => {
            const stream = acceptExec()
            const child = spawn('/bin/sh', ['-c', exec.command], { stdio: ['pipe', 'pipe', 'pipe'] })
            stream.on('data', (chunk: Buffer | string) => child.stdin.write(chunk))
            stream.on('end', () => child.stdin.end())
            child.stdout.on('data', chunk => stream.write(chunk))
            child.stderr.on('data', chunk => stream.stderr.write(chunk))
            child.once('close', (code) => {
              stream.exit(code ?? 1)
              stream.end()
            })
          })
        })
      })
    })
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })

    vi.stubEnv('DSH_SSH_LOOPBACK_PASSWORD', 'secret')
    const anchorRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-loopback-anchor-'))
    const ctx = new Context()
    const runtimeFiber = await ctx.plugin(SshWorkspaceRuntime, {
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'smoke',
      root: '/tmp',
      anchorRoot,
      passwordEnv: 'DSH_SSH_LOOPBACK_PASSWORD',
      hostKeySha256: hostKeyFingerprint(parsed.getPublicSSH()),
      workspaces: [],
    })
    const fsFiber = await ctx.plugin(SshFileSystem)
    const processFiber = await ctx.plugin(SshSubprocessRuntime)
    const subprocess = ctx.subprocess

    try {
      const remoteTmp = await ctx.fs.resolve('.', { cwd: '/tmp' })
      expect(ctx.fs.processPath(remoteTmp)).toBe('/tmp')
      await expect(ctx.fs.stat(remoteTmp)).resolves.toMatchObject({ type: 'directory' })

      const handle = subprocess.spawn({
        argv: ['/bin/sh', '-c', 'IFS= read -r line; printf "remote:%s" "$line"'],
        cwd: '/tmp',
        stdio: {
          stdin: { data: 'hello over ssh\n' },
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 1000,
      })
      await expect(handle.done).resolves.toMatchObject({ exitCode: 0, signal: null })
      expect(handle.collected.stdout?.readFrom(0)).toMatchObject({
        text: 'remote:hello over ssh',
        lossy: false,
      })
      expect(handle.collected.stderr?.readFrom(0).text).toBe('')
    } finally {
      await processFiber.dispose()
      await fsFiber.dispose()
      await runtimeFiber.dispose()
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      await rm(anchorRoot, { recursive: true, force: true })
      vi.unstubAllEnvs()
    }
  }, 15_000)
})
