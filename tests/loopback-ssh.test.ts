import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
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
          let ptyRequested = false
          session.on('pty', (acceptPty) => {
            ptyRequested = true
            acceptPty()
          })
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
            stream.on('data', (chunk: Buffer | string) => {
              const data = Buffer.from(chunk)
              if (ptyRequested && data.includes(0x03)) child.kill('SIGINT')
              else child.stdin.write(data)
            })
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
    const localRoot = await mkdtemp(join(tmpdir(), 'dsh-ssh-loopback-local-'))
    const ctx = new Context()
    ctx.provide('sandboxPolicy', {
      defaultMode: 'workspace-write',
      workspaceRoot: anchorRoot,
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: anchorRoot }),
    } as never)
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
      const remoteRoot = await ctx.sshWorkspace.defaultServer().materializeAnchor('/tmp')
      const remoteTarget = await ctx.fs.resolve('.', { cwd: remoteRoot })
      expect(ctx.fs.processPath(remoteTarget)).toBe('/tmp')
      await expect(ctx.fs.stat(remoteTarget)).resolves.toMatchObject({ type: 'directory' })

      const localTarget = await ctx.fs.resolve('.', { cwd: localRoot })
      expect(ctx.fs.processPath(localTarget)).toBe(localRoot)
      await expect(ctx.fs.stat(localTarget)).resolves.toMatchObject({ type: 'directory' })

      const handle = subprocess.spawn({
        argv: ['/bin/sh', '-c', 'IFS= read -r line; printf "remote:%s" "$line"'],
        cwd: remoteRoot,
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

      const interrupt = new AbortController()
      const survivorPath = join(localRoot, 'interrupted-child-survived')
      const delayedWrite = `setTimeout(()=>require('node:fs').writeFileSync('${survivorPath}','alive'),1500)`
      const interrupted = subprocess.spawn({
        argv: ['/bin/sh', '-c', `${process.execPath} -e "${delayedWrite}" & child=$!; printf "%s\\n" "$child"; wait "$child"`],
        cwd: remoteRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 500,
        signal: interrupt.signal,
      })
      const childPid = await vi.waitFor(() => {
        const text = interrupted.collected.stdout?.readFrom(0).text.trim() ?? ''
        expect(text).toMatch(/^[1-9][0-9]*$/u)
        return Number(text)
      })
      interrupt.abort()
      await expect(interrupted.done).resolves.toBeDefined()
      expect(interrupted.collected.stderr?.readFrom(0).text).not.toContain('dsh-ssh-process:')
      expect(childPid).toBeGreaterThan(0)
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2_000))
      await expect(access(survivorPath)).rejects.toThrow()

      const terminal = await subprocess.spawnTerminal({
        argv: [
          process.execPath,
          '-e',
          "process.on('SIGINT',()=>{process.stdout.write('interrupted');process.exit(0)});process.stdout.write('ready');setInterval(()=>{},1000)",
        ],
        cwd: remoteRoot,
        env: {},
        rows: 24,
        cols: 80,
        graceMs: 500,
      })
      let terminalOutput = ''
      terminal.output.on('data', (chunk: Buffer | string) => { terminalOutput += String(chunk) })
      await vi.waitFor(() => expect(terminalOutput).toContain('ready'))
      await terminal.signalForeground('SIGINT')
      await expect(terminal.done).resolves.toBeDefined()
      expect(terminalOutput).toContain('interrupted')

      const localHandle = subprocess.spawn({
        argv: [process.execPath, '-e', 'process.stdout.write(`local:${process.cwd()}`)'],
        cwd: localRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 1024 },
          stderr: { maxBytes: 1024 },
        },
        graceMs: 1000,
      })
      await expect(localHandle.done).resolves.toMatchObject({ exitCode: 0, signal: null })
      expect(localHandle.collected.stdout?.readFrom(0).text).toBe(`local:${localRoot}`)
    } finally {
      await processFiber.dispose()
      await fsFiber.dispose()
      await runtimeFiber.dispose()
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      await rm(anchorRoot, { recursive: true, force: true })
      await rm(localRoot, { recursive: true, force: true })
      vi.unstubAllEnvs()
    }
  }, 15_000)
})
