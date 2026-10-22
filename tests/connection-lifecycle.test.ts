import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate as turn } from 'node:timers/promises'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { SandboxProvider, SandboxUnavailableError, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SshWorkspaceManager } from '../src/manager.js'
import { installFsRouting } from '../src/fs-routing.js'

/** Real published SshConnection, providers and RPC framing; only the SSH child
 * transport is replaced by in-memory streams, so no AF_UNIX/FUSE is required. */
async function fixture(t: TestContext, options: { hostUnavailable?: boolean; remoteUnavailable?: boolean; remoteDetail?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-lifecycle-'))
  await writeFile(join(directory, 'AGENTS.md'), 'Remote project instructions')
  const host = new Context(), remote = new Context()
  await host.plugin(LocalFileSystem)
  await remote.plugin(LocalFileSystem)
  let sandboxAvailable = !options.remoteUnavailable
  const facts = (argv: readonly string[]) => ({ argv: ['/fixture/runner', ...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] })
  class HostSandbox extends SandboxProvider {
    override async confine(argv: readonly string[], policy: SandboxPolicy) {
      assert.equal(policy.mode, 'read-only')
      if (options.hostUnavailable) throw new SandboxUnavailableError(policy.mode)
      return facts(argv)
    }
  }
  await host.plugin(HostSandbox)
  const heartbeatGate = Promise.withResolvers<void>(), readGate = Promise.withResolvers<void>(), monitorGate = Promise.withResolvers<void>()
  const sessions: Array<{ peer: SshRpcPeer; kill: () => void }> = []
  const methods: string[] = []
  let heldReads = false, heldMonitors = false
  t.mock.timers.enable({ apis: ['setInterval'] })
  const spawn = t.mock.method(childProcess, 'spawn', ((command: string) => {
    assert.equal(command, 'ssh')
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const child = new EventEmitter() as any
    const kill = () => {
      if (child.killed) return true
      child.killed = true
      stdin.destroy(); stdout.destroy(); stderr.destroy()
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    }
    Object.assign(child, { stdin, stdout, stderr, killed: false, kill })
    const peer = new SshRpcPeer(stdin, stdout, 64 * 1024 * 1024, 128, async (method, params: any) => {
      methods.push(method)
      if (method === 'hello') return { protocol: 2, hash: 'a'.repeat(64), kind: 'executable', platform: 'linux',
        nodeVersion: process.version, executable: '/fixture/helper', root: directory, workspace: '/' }
      if (method === 'heartbeat') { await heartbeatGate.promise; return null }
      if (method === 'sandbox') {
        assert.equal(params.policy.mode, 'read-only')
        if (!sandboxAvailable) throw new SandboxUnavailableError(params.policy.mode, options.remoteDetail)
        return facts(params.argv)
      }
      if (method === 'executable') return '/usr/bin/rg'
      if (method === 'terminal.environment') {
        if (heldMonitors) await monitorGate.promise
        return { platform: 'posix', defaultShell: '/bin/bash' }
      }
      if (method === 'fs.resolve') return remote.fs.resolve(params.path, { cwd: params.cwd })
      if (method === 'fs.readText') {
        if (heldReads) await readGate.promise
        return remote.fs.readText(params.target)
      }
      if (method === 'close') return null
      throw new Error(`Unexpected fixture method: ${method}`)
    })
    sessions.push({ peer, kill })
    return child
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  const manager = new SshWorkspaceManager(host, { stateDir: join(directory, 'state'), mountRoot: join(directory, 'mounts') })
  let restoreFs: (() => void | Promise<void>) | undefined
  t.after(async () => {
    heartbeatGate.resolve(); readGate.resolve(); monitorGate.resolve()
    try { await restoreFs?.(); await manager.dispose() }
    finally {
      for (const session of sessions) { session.peer.close(); session.kill() }
      await host.fiber.dispose(); await remote.fiber.dispose()
      spawn.mock.restore(); syncBuiltinESMExports(); t.mock.timers.reset()
      await rm(directory, { recursive: true, force: true })
    }
  })
  await manager.ready
  const added = await manager.upsertServer({ label: 'Fixture', host: 'fixture', helperMode: 'manual', helper: '/fixture/helper',
    helperHash: 'a'.repeat(64), launch: { kind: 'executable' } })
  const id = added.servers[0]!.id
  await manager.connect(id)
  const mount = { serverId: id, localPath: '/virtual-ssh-workspace', remotePath: directory, status: 'mounted' as const }
  restoreFs = installFsRouting(host, { listMounts: () => [mount], getRemote: value => manager.getRemote(value) })
  return { manager, id, methods, host, sessions, heartbeatGate, readGate,
    setSandboxAvailable(value: boolean) { sandboxAvailable = value },
    async savedState() { return JSON.parse(await readFile(join(directory, 'state/state.json'), 'utf8')) },
    holdReads() { heldReads = true },
    holdMonitors() { heldMonitors = true },
    releaseMonitors() { heldMonitors = false; monitorGate.resolve() },
    async tick() { t.mock.timers.tick(10_000); await turn(); await turn() },
    async readProject() {
      const target = await host.fs.resolve('/virtual-ssh-workspace/AGENTS.md')
      return host.fs.readText(target)
    },
  }
}

test('unavailable remote sandbox is visible before chat while SSH files remain usable', async t => {
  const detail = 'Managed helper sandbox probes: linux-arm64, kernel=fixture, euid=1000\nBundled bubblewrap: exit=1; stderr=bwrap: Operation not permitted\nLandlock: exit=125; stderr=landlock is not enforced by this kernel'
  const f = await fixture(t, { remoteUnavailable: true, remoteDetail: detail })
  const server = f.manager.state().servers[0]!
  assert.equal(server.status, 'connected')
  assert.equal(server.sandboxChecks?.host.status, 'selected')
  assert.equal(server.sandboxChecks?.remote.status, 'unavailable')
  assert.match(server.sandboxChecks!.remote.message, /SSH server fixture/u)
  assert.doesNotMatch(server.sandboxChecks!.remote.message, /Runner failure:/u)
  assert.ok(server.sandboxChecks!.remote.message.includes(detail), 'all probe lines survive the official SSH error wrapper')
  assert.equal(await f.readProject(), 'Remote project instructions')
  const result = await f.manager.probe(f.id)
  assert.equal(result.ok, false)
  assert.match(result.message, /SSH connected, sandbox preflight failed: remote/u)
  assert.ok(f.manager.state().servers[0]!.sandboxChecks!.remote.message.includes(detail))
  assert.equal(f.manager.state().servers[0]!.status, 'connected')
  assert.ok(!f.methods.some(method => method.startsWith('process.')))
  // Ephemeral diagnostics must not enter the strict persisted-state schema.
  await f.manager.upsertServer({ label: 'Another', host: 'another' })
  assert.equal((await f.savedState()).servers[0].sandboxChecks, undefined)
  await f.manager.disconnect(f.id)
  assert.equal(f.manager.state().servers[0]!.sandboxChecks, undefined)
  f.setSandboxAvailable(true)
  await f.manager.connect(f.id)
  assert.equal(f.manager.state().servers[0]!.sandboxChecks?.remote.status, 'selected')
})

test('Host-only sandbox failure is distinguished from remote capability', async t => {
  const f = await fixture(t, { hostUnavailable: true })
  const checks = f.manager.state().servers[0]!.sandboxChecks!
  assert.equal(checks.host.status, 'unavailable')
  assert.match(checks.host.message, /DSH Host/u)
  assert.equal(checks.remote.status, 'selected')
  assert.equal(await f.readProject(), 'Remote project instructions')
})

test('native heartbeat and manager monitoring overlap without taking the workspace offline', async t => {
  const f = await fixture(t)
  await f.tick()
  assert.equal(f.methods.filter(method => method === 'heartbeat').length, 1)
  assert.equal(f.manager.state().servers[0]!.status, 'connected', f.manager.state().servers[0]!.error)
  assert.equal(await f.readProject(), 'Remote project instructions')
  // A slow heartbeat remains outstanding across the next monitor interval.
  await f.tick()
  assert.equal(f.methods.filter(method => method === 'heartbeat').length, 1)
  assert.equal(f.manager.state().servers[0]!.status, 'connected')
  f.heartbeatGate.resolve(); await turn()
  await f.tick()
  assert.equal(f.methods.filter(method => method === 'heartbeat').length, 2)
  assert.equal(await f.readProject(), 'Remote project instructions')
})

test('ordinary RPC saturation cannot poison connection status or consume reserved heartbeat capacity', async t => {
  const f = await fixture(t)
  const provider = f.manager.getRemote(f.id)!
  const target = await f.host.fs.resolve('/virtual-ssh-workspace/AGENTS.md')
  f.holdReads()
  const reads = Array.from({ length: 128 }, () => f.host.fs.readText(target))
  const completed = Promise.all(reads)
  void completed.catch(() => {})
  await turn(); await turn()
  assert.equal(f.methods.filter(method => method === 'fs.readText').length, 128)
  await f.tick()
  assert.equal(f.manager.state().servers[0]!.status, 'connected', f.manager.state().servers[0]!.error)
  assert.equal(f.manager.getRemote(f.id), provider)
  assert.equal(f.methods.filter(method => method === 'heartbeat').length, 1)
  // No retries/replays of admitted reads; the next idle probe succeeds normally.
  f.readGate.resolve(); f.heartbeatGate.resolve()
  assert.equal((await completed).length, 128)
  await turn(); await f.tick()
  assert.equal(f.methods.filter(method => method === 'fs.readText').length, 128)
  assert.ok(f.methods.includes('terminal.environment'))
  assert.equal(await f.readProject(), 'Remote project instructions')
})

test('real transport failure still marks the server offline and reconnect replaces its provider', async t => {
  const f = await fixture(t)
  const original = f.manager.getRemote(f.id)
  f.sessions[0]!.kill()
  await turn(); await f.tick()
  assert.equal(f.manager.state().servers[0]!.status, 'error')
  assert.equal(f.manager.getRemote(f.id), undefined)
  await assert.rejects(f.readProject(), /is offline/u)
  await f.manager.disconnect(f.id)
  await f.manager.connect(f.id)
  assert.notEqual(f.manager.getRemote(f.id), original)
  await f.tick()
  assert.equal(f.manager.state().servers[0]!.status, 'connected')
  assert.equal(await f.readProject(), 'Remote project instructions')
})

test('slow UI probes never overlap and a disposed generation cannot invalidate a reconnect', async t => {
  const f = await fixture(t)
  f.holdMonitors()
  f.heartbeatGate.resolve()
  await f.tick(); await f.tick(); await f.tick()
  assert.equal(f.methods.filter(method => method === 'terminal.environment').length, 1)
  assert.equal(f.methods.filter(method => method === 'heartbeat').length, 3)
  assert.equal(await f.readProject(), 'Remote project instructions')
  await f.manager.disconnect(f.id)
  assert.equal(f.manager.state().servers[0]!.status, 'disconnected')
  await f.manager.connect(f.id)
  f.releaseMonitors()
  await turn(); await f.tick()
  assert.equal(f.manager.state().servers[0]!.status, 'connected')
  assert.equal(await f.readProject(), 'Remote project instructions')
})
