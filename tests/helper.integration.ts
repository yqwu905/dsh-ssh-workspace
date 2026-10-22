/** Real OpenSSH + SSH2 fixture; runtime is downloaded/prepared on Host, installed over encrypted stdin. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { join, dirname } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import ssh2, { type Connection } from 'ssh2'
import { command, shellQuote as q, sshCommand } from '../src/commands.ts'
import { prepareBundle, isTarget } from '../src/helper-bundle.ts'
import { detectPlatform, deployBundle, ensureHelper, installationScript } from '../src/helper-install.ts'
import { Context } from '@deepseek-ai/cordis'
import { SshWorkspaceManager } from '../src/manager.ts'

test('automatic helper installation through real OpenSSH', { timeout: 1_200_000 }, async t => {
  const target = `${process.platform}-${process.arch}`
  if (!isTarget(target)) { t.skip('Requires a supported POSIX host'); return }
  const root = await mkdtemp(join(tmpdir(), 'dsh-auto-helper-'))
  const remoteHome = join(root, "remote home ' literal")
  const cache = process.env.DSH_HELPER_TEST_CACHE ?? join(tmpdir(), 'dsh-auto-helper-test-cache')
  const originalPath = process.env.PATH
  const peers = new Set<Connection>(), children = new Set<ChildProcess>()
  let server: ssh2.Server | undefined
  let errors = ''
  try {
    await mkdir(remoteHome)
    await mkdir(join(root, 'bin'))
    await mkdir(join(root, 'remote-bin'))
    for (const name of ['node', 'npm', 'curl', 'wget']) await writeFile(join(root, 'remote-bin', name), '#!/bin/sh\necho "remote download/system Node is disabled by fixture" >&2\nexit 99\n', { mode: 0o700 })
    for (const name of ['host', 'client']) await command('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)])
    const client = ssh2.utils.parseKey(await readFile(join(root, 'client.pub')))
    if (client instanceof Error || Array.isArray(client)) throw new Error('Invalid fixture key')
    server = new ssh2.Server({ hostKeys: [await readFile(join(root, 'host'))] }, peer => {
      peers.add(peer)
      peer.on('error', error => { errors += error.message + '\n' })
      peer.on('close', () => peers.delete(peer))
      peer.on('authentication', auth => {
        if (auth.method !== 'publickey' || auth.username !== userInfo().username || !auth.key.data.equals(client.getPublicSSH())) { auth.reject(); return }
        if (auth.signature && (!auth.blob || client.verify(auth.blob, auth.signature, auth.hashAlgo) !== true)) { auth.reject(); return }
        auth.accept()
      })
      peer.on('ready', () => peer.on('session', accept => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const channel = acceptExec()
          const child = spawn('/bin/sh', ['-c', info.command], { stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, HOME: remoteHome, PATH: `${join(root, 'remote-bin')}:/usr/bin:/bin` } })
          children.add(child)
          child.stdin.on('error', () => {})
          child.on('error', error => { channel.stderr.write(error.message); channel.exit(127); channel.end() })
          channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false })
          channel.on('close', () => child.kill())
          channel.on('error', () => child.kill())
          child.on('close', code => { children.delete(child); channel.exit(code ?? 1); channel.end() })
        })
      }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    const hostKey = (await readFile(join(root, 'host.pub'), 'utf8')).trim().split(' ').slice(0, 2).join(' ')
    await writeFile(join(root, 'known_hosts'), `[127.0.0.1]:${address.port} ${hostKey}\n`, { mode: 0o600 })
    await writeFile(join(root, 'config'), `Host helper-test
  HostName 127.0.0.1
  User ${userInfo().username}
  Port ${address.port}
  IdentityFile ${join(root, 'client')}
  UserKnownHostsFile ${join(root, 'known_hosts')}
  GlobalKnownHostsFile /dev/null
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
`, { mode: 0o600 })
    await writeFile(join(root, 'bin/ssh'), `#!/bin/sh\nexec /usr/bin/ssh -F ${q(join(root, 'config'))} "$@"\n`, { mode: 0o700 })
    process.env.PATH = `${join(root, 'bin')}:${originalPath ?? ''}`
    assert.deepEqual(await detectPlatform('helper-test'), { home: remoteHome, target })
    await assert.rejects(sshCommand('helper-test', 'node --version'), /disabled by fixture/u)
    const phases: string[] = []
    let installed = await ensureHelper('helper-test', cache, 600_000, phase => phases.push(phase))
    await t.test('installs complete pinned runtime with bundled Node and native add-ons', async () => {
      assert.ok(installed.helper.startsWith(remoteHome + '/'))
      assert.equal(installed.launch.kind, 'node-script')
      assert.deepEqual(phases, ['detecting', 'preparing', 'uploading', 'verifying'])
      assert.equal((await sshCommand('helper-test', `${q(installed.launch.node)} --version`)).trim(), 'v24.19.0')
      assert.match(await readFile(installed.helper, 'utf8'), /runSshHelper/u)
    })
    await t.test('reconnect reuses verified deployment without retransmission', async () => {
      const repeated: string[] = []
      const next = await ensureHelper('helper-test', cache, 600_000, phase => repeated.push(phase), installed.helper)
      assert.deepEqual(next, installed)
      assert.equal(repeated.includes('uploading'), false)
    })
    await t.test('corrupt installed payload is replaced in a fresh directory', async () => {
      const old = installed.helper
      await chmod(old, 0o600); await writeFile(old, 'corrupted fixture')
      const next = await ensureHelper('helper-test', cache, 600_000, () => {}, old)
      assert.notEqual(next.helper, old)
      assert.equal(await readFile(old, 'utf8'), 'corrupted fixture')
      installed = next
    })
    await t.test('bad/truncated transfer never becomes an installed runtime', async () => {
      const bundle = await prepareBundle(target, cache, 600_000)
      const directory = join(remoteHome, '.local/share/dsh-ssh-workspaces/runtimes', bundle.key + '-bad-transfer')
      await assert.rejects(sshCommand('helper-test', installationScript(directory, bundle), { input: 'truncated bytes', timeoutMs: 20_000 }), /checksum mismatch/u)
      const names = await readdir(dirname(directory))
      assert.equal(names.some(name => name.includes('bad-transfer')), false)
      await assert.rejects(deployBundle('helper-test', remoteHome, { ...bundle, archiveHash: '0'.repeat(64) }, 30_000, () => {}), /checksum mismatch/u)
    })
    await t.test('background Manager connection persists automatic configuration before native transport', async () => {
      const ctx = new Context()
      const stateDir = join(root, 'manager-state')
      await mkdir(stateDir)
      await symlink(join(cache, 'helper-cache'), join(stateDir, 'helper-cache'), 'dir')
      const manager = new SshWorkspaceManager(ctx, { stateDir, mountRoot: join(root, 'mounts'), requestTimeoutMs: 2000 })
      try {
        await manager.ready
        const state = await manager.upsertServer({ label: 'Auto fixture', host: 'helper-test', helperMode: 'auto', ...installed })
        const id = state.servers.at(-1)!.id
        assert.equal(manager.beginConnect(id).servers.find(item => item.id === id)!.status, 'connecting')
        const deadline = Date.now() + 30_000
        let sawInstallation = false
        while (Date.now() < deadline) {
          const server = manager.state().servers.find(item => item.id === id)!
          sawInstallation ||= server.status === 'installing'
          if (server.status === 'error') break
          await delay(30)
        }
        assert.equal(sawInstallation, true)
        assert.equal(manager.state().servers.find(item => item.id === id)!.status, 'error', 'fixture deliberately lacks native stream forwarding')
        await manager.dispose()
        const saved = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8')).servers.find((item: {id: string}) => item.id === id)
        assert.equal(saved.helperMode, 'auto'); assert.equal(saved.helper, installed.helper)
        assert.equal(saved.setupPhase, undefined)
        assert.equal(manager.getRemote(id), undefined)
      } finally {
        await manager.dispose(); await ctx.fiber.dispose()
        // Remove the cache link before recursive fixture cleanup; the reusable host cache is kept.
        await rm(join(stateDir, 'helper-cache'), { force: true })
      }
    })
    t.diagnostic('OpenSSH transport, archive/inventory verification and native module loading passed. This fixture blocks ambient node/npm/curl/wget; kernel confinement and FUSE are separate gates.')
  } catch (error) { if (errors) t.diagnostic(errors); throw error }
  finally {
    process.env.PATH = originalPath
    for (const peer of peers) peer.end()
    for (const child of children) child.kill('SIGKILL')
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    await command('chmod', ['-R', 'u+w', root]).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
