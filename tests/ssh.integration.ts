/** Real loopback OpenSSH acceptance. No user SSH configuration or API credentials are used. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer, connect, type AddressInfo } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SshConnection } from '@deepseek-ai/dsh-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'
const { Server: SshServer, utils: sshUtils } = ssh2
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SshWorkspaceManager } from '../src/manager.ts'

const runFile = promisify(execFile)
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

async function reachable(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
    socket.setTimeout(200, () => { socket.destroy(); resolve(false) })
  })
}

async function until(predicate: () => Promise<boolean>, detail: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await predicate()) return
    await delay(40)
  }
  throw new Error(`Timed out: ${detail}`)
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = once(child, 'close')
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 2000)
  try { await closed } finally { clearTimeout(force) }
}

async function result(handle: SubprocessHandle) {
  const outcome = await handle.done
  assert.equal(await handle.waitForExit(AbortSignal.timeout(10_000)), true)
  return { ...outcome, stdout: handle.collected.stdout?.readFrom(0).text ?? '', stderr: handle.collected.stderr?.readFrom(0).text ?? '' }
}

function spec(argv: string[], cwd: string): SubprocessSpawnSpec {
  return { argv, cwd, graceMs: 500, stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } } }
}

test('OpenSSH transport and conditional native DSH helper acceptance', {
  timeout: 120_000,
  skip: process.platform !== 'linux' ? 'Requires Linux for the loopback helper fixture.' : false,
}, async t => {
  const useOpenSshDaemon = process.env.RUN_SSHD === '1'
  if (useOpenSshDaemon) await access('/usr/sbin/sshd')
  const root = await mkdtemp(join(tmpdir(), 'dsh-ws-it-'))
  const originalPath = process.env.PATH
  let daemon: ChildProcess | undefined
  let testSshServer: InstanceType<typeof SshServer> | undefined
  const sshPeers = new Set<Connection>()
  const sshChildren = new Set<ChildProcess>()
  let tunnel: ChildProcess | undefined
  let connection: SshConnection | undefined
  let createdRunDirectory = false
  const ctx = new Context()
  const hostHttp = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    response.write('data: host-first\n\n')
    setTimeout(() => response.end('data: host-last\n\n'), 120)
  })
  let daemonErrors = ''
  try {
    if (useOpenSshDaemon) {
      try { await access('/run/sshd') } catch { await mkdir('/run/sshd', { mode: 0o755 }); createdRunDirectory = true }
    }
    await mkdir(join(root, 'bin'), { mode: 0o700 })
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    await runFile('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host')])
    await runFile('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'client')])
    const port = await freePort()
    const username = userInfo().username
    const sshdConfig = [
      `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host')}`,
      `PidFile ${join(root, 'sshd.pid')}`, `AuthorizedKeysFile ${join(root, 'client.pub')}`,
      'StrictModes no', 'PermitRootLogin yes', 'PubkeyAuthentication yes',
      'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no',
      'AllowTcpForwarding yes', 'AllowStreamLocalForwarding yes', 'GatewayPorts no',
      'PermitUserEnvironment no', 'PrintMotd no', 'LogLevel ERROR',
      'Subsystem sftp internal-sftp',
    ].join('\n') + '\n'
    await writeFile(join(root, 'sshd.conf'), sshdConfig, { mode: 0o600 })
    const key = (await readFile(join(root, 'host.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ')
    await writeFile(join(root, 'known_hosts'), `[127.0.0.1]:${port} ${key}\n`, { mode: 0o600 })
    const sshConfig = [
      'Host dsh-test', '  HostName 127.0.0.1', `  Port ${port}`, `  User ${username}`,
      `  IdentityFile ${join(root, 'client')}`, `  UserKnownHostsFile ${join(root, 'known_hosts')}`,
      '  GlobalKnownHostsFile /dev/null', '  StrictHostKeyChecking yes', '  BatchMode yes',
      '  IdentitiesOnly yes', '  ForwardAgent no',
    ].join('\n') + '\n'
    await writeFile(join(root, 'ssh.conf'), sshConfig, { mode: 0o600 })
    await writeFile(join(root, 'bin', 'ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${quote(join(root, 'ssh.conf'))} "$@" 2>>${quote(join(root, 'client-errors.log'))}\n`, { mode: 0o700 })
    if (useOpenSshDaemon) {
      daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd.conf')], { stdio: ['ignore', 'ignore', 'pipe'] })
      daemon.stderr?.on('data', chunk => { daemonErrors += chunk.toString() })
      await until(() => reachable(port), `sshd startup: ${daemonErrors}`)
    } else {
      // Unprivileged server fixture: the production OpenSSH client, its master
      // connection and encrypted channels are real. No privileged chroot is needed.
      const parsed = sshUtils.parseKey(await readFile(join(root, 'client.pub')))
      if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Cannot parse test public key')
      const hostKey = await readFile(join(root, 'host'))
      testSshServer = new SshServer({ hostKeys: [hostKey] }, peer => {
        sshPeers.add(peer)
        peer.setNoDelay(true)
        const forwards = new Set<ReturnType<typeof createServer>>()
        peer.on('error', error => { daemonErrors += `${error.message}\n` })
        peer.on('close', () => { sshPeers.delete(peer); for (const forward of forwards) forward.close() })
        peer.on('authentication', auth => {
          if (auth.method !== 'publickey' || auth.username !== username || !auth.key.data.equals(parsed.getPublicSSH())) { auth.reject(); return }
          if (auth.signature && (!auth.blob || parsed.verify(auth.blob, auth.signature, auth.hashAlgo) !== true)) { auth.reject(); return }
          auth.accept()
        })
        peer.on('ready', () => {
          peer.on('session', accept => {
            const session = accept()
            session.on('exec', (acceptExec, _reject, info) => {
              const channel = acceptExec()
              daemonErrors += `exec: ${info.command}\n`
              const child = spawn('/bin/sh', ['-c', info.command], { stdio: ['pipe', 'pipe', 'pipe'] })
              sshChildren.add(child)
              child.on('error', error => { channel.stderr.write(error.message); channel.exit(127); channel.end() })
              channel.pipe(child.stdin)
              child.stdout.pipe(channel, { end: false })
              child.stderr.pipe(channel.stderr, { end: false })
              child.stderr.on('data', chunk => { daemonErrors = (daemonErrors + chunk.toString()).slice(-16000) })
              channel.on('error', () => child.kill())
              channel.on('close', () => child.kill())
              child.on('close', code => { daemonErrors += `child exit: ${code}\n`; sshChildren.delete(child); channel.exit(code ?? 1); channel.end() })
            })
          })
          peer.on('openssh.streamlocal', (acceptStream, reject, info) => {
            if (!info.socketPath.startsWith('/tmp/dsh-ssh-')) { reject(); return }
            const socket = connect({ path: info.socketPath, allowHalfOpen: true })
            socket.once('error', () => reject())
            socket.once('connect', () => {
              socket.removeAllListeners('error')
              const channel = acceptStream()
              socket.on('error', () => channel.destroy())
              channel.on('error', () => socket.destroy())
              socket.pipe(channel).pipe(socket)
              channel.on('close', () => socket.destroy())
            })
          })
          peer.on('request', (acceptRequest, reject, name, info) => {
            if (name !== 'tcpip-forward' || info.bindAddr !== '127.0.0.1') { reject?.(); return }
            const forward = createServer(socket => {
              peer.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (error, channel) => {
                if (error) { socket.destroy(); return }
                socket.on('error', () => channel.destroy())
                channel.on('error', () => socket.destroy())
                socket.pipe(channel).pipe(socket)
                channel.on('close', () => socket.destroy())
              })
            })
            forwards.add(forward)
            forward.once('error', () => { forwards.delete(forward); reject?.() })
            forward.listen(info.bindPort, info.bindAddr, () => acceptRequest?.())
          })
        })
      })
      testSshServer.listen(port, '127.0.0.1')
      await once(testSshServer, 'listening')
    }
    const connected = await runFile('/usr/bin/ssh', ['-F', join(root, 'ssh.conf'), 'dsh-test', 'printf ssh-ready'])
    assert.equal(connected.stdout, 'ssh-ready')
    await t.test('encrypted SSH executes parallel commands in separate directories', async () => {
      const [a, b] = await Promise.all([
        runFile('/usr/bin/ssh', ['-F', join(root, 'ssh.conf'), 'dsh-test', `cd ${quote(join(root, 'a'))} && printf alpha > direct-marker && cat direct-marker`]),
        runFile('/usr/bin/ssh', ['-F', join(root, 'ssh.conf'), 'dsh-test', `cd ${quote(join(root, 'b'))} && printf beta > direct-marker && cat direct-marker`]),
      ])
      assert.equal(a.stdout, 'alpha')
      assert.equal(b.stdout, 'beta')
    })
    await t.test('reverse TCP tunnel streams host HTTP SSE to an SSH command', async () => {
      hostHttp.listen(0, '127.0.0.1')
      await once(hostHttp, 'listening')
      const hostPort = (hostHttp.address() as AddressInfo).port
      const remotePort = await freePort()
      tunnel = spawn('/usr/bin/ssh', ['-F', join(root, 'ssh.conf'), '-N', '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${hostPort}`, 'dsh-test'], { stdio: ['ignore', 'ignore', 'pipe'] })
      await until(() => reachable(remotePort), 'reverse tunnel listener')
      const code = `const r=await fetch('http://127.0.0.1:${remotePort}');let n=0;for await(const b of r.body){n++;process.stdout.write(b)}process.stderr.write(String(n));`
      const response = await runFile('/usr/bin/ssh', ['-F', join(root, 'ssh.conf'), 'dsh-test', [process.execPath, '--input-type=module', '-e', code].map(quote).join(' ')])
      assert.equal(response.stdout, 'data: host-first\n\ndata: host-last\n\n')
      assert.ok(Number(response.stderr) >= 2, 'SSE arrives in multiple chunks')
      await stop(tunnel)
      tunnel = undefined
    })
    const unixAllowed = await new Promise<boolean>(resolve => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(join(root, 'unix-probe'), () => probe.close(() => resolve(true)))
    })
    process.env.PATH = `${join(root, 'bin')}:${originalPath ?? ''}`
    const helper = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper'))
    const helperHash = createHash('sha256').update(await readFile(helper)).digest('hex')
    if (!unixAllowed) {
      await t.test('manager refuses unavailable transport without exposing remote providers', async () => {
        const manager = new SshWorkspaceManager(ctx, { stateDir: join(root, 'state'), mountRoot: join(root, 'mounts'), requestTimeoutMs: 2000 })
        try {
          await manager.ready
          const state = await manager.upsertServer({ label: 'Test server', host: 'dsh-test', helper, helperHash, launch: { kind: 'node-script', node: process.execPath } })
          const id = state.servers[0].id
          await assert.rejects(manager.connect(id), /SSH|socket|connection|disconnected/i)
          assert.equal(manager.getRemote(id), undefined)
          assert.equal(manager.state().servers[0].status, 'error')
          await manager.disconnect(id)
          assert.equal(manager.state().servers[0].status, 'disconnected')
          assert.equal(manager.state().servers[0].id, id)
        } finally { await manager.dispose() }
      })
      await t.test('native helper, managed cancellation, sandbox and multiplexing', { skip: 'Execution host denies AF_UNIX socket creation; native DSH ControlMaster and helper streams cannot run here.' }, () => {})
      t.diagnostic('Direct OpenSSH exec and reverse TCP forwarding passed using an unprivileged SSH2 server fixture. Production sshd is separately selected by RUN_SSHD=1; this environment denies its chroot.')
      t.diagnostic('Native provider execution, SSHFS/FUSE mount and production latency remain unverified in this environment.')
      return
    }
    connection = new SshConnection(ctx, {
      host: 'dsh-test', helper, helperHash, workspace: root,
      launch: { kind: 'node-script', node: process.execPath },
      requestTimeoutMs: 15_000, maxFrameBytes: 64 * 1024 * 1024, maxPending: 128, leaseMs: 30_000,
    })
    const hello = await connection.ready
    const remote = new SshSubprocessRuntime(ctx)
    const sandbox = new SshSandboxProvider(ctx)
    assert.equal(hello.workspace, root)

    await t.test('real stdout/stderr and independent simultaneous working directories', async () => {
      const [a, b] = await Promise.all([
        result(remote.spawn(spec(['/bin/sh', '-c', 'printf alpha > marker; printf "A:"; cat marker; printf warning >&2'], join(root, 'a')))),
        result(remote.spawn(spec(['/bin/sh', '-c', 'printf beta > marker; printf "B:"; cat marker'], join(root, 'b')))),
      ])
      assert.deepEqual(a, { exitCode: 0, signal: null, stdout: 'A:alpha', stderr: 'warning' })
      assert.deepEqual(b, { exitCode: 0, signal: null, stdout: 'B:beta', stderr: '' })
      assert.equal(await readFile(join(root, 'a', 'marker'), 'utf8'), 'alpha')
      assert.equal(await readFile(join(root, 'b', 'marker'), 'utf8'), 'beta')
    })

    await t.test('cancellation waits for remote process cleanup', async () => {
      const handle = remote.spawn(spec(['/bin/sh', '-c', 'echo $$ > process.pid; exec sleep 60'], join(root, 'a')))
      await until(async () => { try { await access(join(root, 'a', 'process.pid')); return true } catch { return false } }, 'remote child startup')
      const pid = Number((await readFile(join(root, 'a', 'process.pid'), 'utf8')).trim())
      handle.terminate()
      const outcome = await handle.done
      assert.ok(outcome.signal !== null || outcome.exitCode !== 0)
      assert.equal(await handle.waitForExit(AbortSignal.timeout(10_000)), true)
      await until(async () => { try { process.kill(pid, 0); return false } catch { return true } }, 'remote PID teardown')
    })

    await t.test('remote sandbox either enforces read-only or fails closed', async () => {
      let argv: string[]
      try {
        argv = (await sandbox.confine(['/bin/sh', '-c', 'echo forbidden > forbidden'], { mode: 'read-only', workspaceRoot: join(root, 'a') })).argv
      } catch (error) {
        assert.match(String(error), /sandbox|confin|backend|runner/i)
        t.diagnostic(`Remote read-only backend unavailable; fail-closed rejection verified: ${String(error).slice(0, 180)}`)
        return
      }
      const output = await result(remote.spawn(spec(argv, join(root, 'a'))))
      assert.notEqual(output.exitCode, 0)
      await assert.rejects(access(join(root, 'a', 'forbidden')))
    })

    await t.test('warm shared transport latency sample', async () => {
      const durations: number[] = []
      for (let i = 0; i < 5; i++) {
        const start = performance.now()
        assert.equal((await result(remote.spawn(spec(['/bin/true'], root)))).exitCode, 0)
        durations.push(performance.now() - start)
      }
      const ordered = durations.toSorted((a, b) => a - b)
      t.diagnostic(`Loopback warm process RPC, 5 samples: median ${ordered[2].toFixed(1)} ms, range ${ordered[0].toFixed(1)}–${ordered[4].toFixed(1)} ms. Includes helper-managed process and stream allocation, not WAN or SSHFS.`)
    })
    t.diagnostic(`SSH server fixture: ${useOpenSshDaemon ? 'OpenSSH sshd' : 'unprivileged SSH2 server; OpenSSH client and multiplexing are real'}.`)
    t.diagnostic('SSHFS/FUSE mounting is a separate acceptance gate; this suite does not claim mount verification.')
  } catch (error) {
    t.diagnostic(`sshd diagnostics: ${daemonErrors}`)
    try { t.diagnostic(await readFile(join(root, 'client-errors.log'), 'utf8')) } catch {}
    throw error
  } finally {
    try { await connection?.dispose() } finally {
      await stop(tunnel)
      if (hostHttp.listening) await new Promise<void>(resolve => hostHttp.close(() => resolve()))
      await stop(daemon)
      for (const peer of sshPeers) peer.end()
      for (const child of sshChildren) await stop(child)
      if (testSshServer) await new Promise<void>(resolve => testSshServer!.close(() => resolve()))
      process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
      if (createdRunDirectory) await rmdir('/run/sshd').catch(() => {})
    }
  }
})
