import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readlink, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { SshWorkspaceManager, decodeMountPath, mountinfoContains } from '../src/manager.js'
import { serverInput, workspaceInput } from '../src/config.js'

const server = { label: 'Training host', host: 'training', helper: '/opt/dsh/helper', helperHash: 'a'.repeat(64), launch: { kind: 'executable' as const } }
test('browser inputs cannot introduce SSH flags or arbitrary reverse-forward hosts', () => {
  assert.throws(() => serverInput.parse({ ...server, host: '-oProxyCommand=evil' }))
  assert.throws(() => serverInput.parse({ ...server, tunnels: [{ remotePort: 9000, host: 'other.example', port: 9000 }] }))
  assert.throws(() => serverInput.parse({ ...server, helper: '/tmp/helper\nother' }))
  assert.throws(() => serverInput.parse({ ...server, helperHash: 'unverified' }))
  assert.throws(() => serverInput.parse({ ...server, privateKey: 'secret' }))
  assert.throws(() => workspaceInput.parse({ serverId: '67fdcd3d-e2c6-4c07-bac2-8ab96bd73bac', title: 'Relative', remotePath: '../foo' }))
  assert.equal(serverInput.parse(server).tunnels.length, 0)
  assert.equal(serverInput.parse({ host: 'new-server', label: 'New', helperMode: 'auto' }).helper, undefined)
  assert.throws(() => serverInput.parse({ host: 'new-server', label: 'New', helperMode: 'manual' }))
})
test('automatic mode needs no helper fields and persists across restarts; old records retain manual mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-auto-manager-test-'))
  const ctx = new Context(), options = { stateDir: join(directory, 'state'), mountRoot: join(directory, 'mounts') }
  let manager: SshWorkspaceManager | undefined
  try {
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    await manager.upsertServer({ label: 'Automatic', host: 'from-config' })
    await manager.upsertServer(server)
    assert.deepEqual(manager.state().servers.map(item => item.helperMode), ['auto', 'manual'])
    await manager.dispose()
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    assert.deepEqual(manager.state().servers.map(item => item.helperMode), ['auto', 'manual'])
    assert.equal(manager.state().servers[0].helper, undefined)
  } finally {
    await manager?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true })
  }
})
test('mountinfo matching is exact and accepts only FUSE SSH filesystem types', () => {
  const text = '50 1 0:50 / /home/user/mount\\040one rw - fuse.sshfs training:/data rw\n51 1 8:2 / /home/user/mount-two rw - ext4 /dev/sda rw'
  assert.equal(decodeMountPath('/mount\\040one'), '/mount one')
  assert.equal(mountinfoContains(text, '/home/user/mount one'), true)
  assert.equal(mountinfoContains(text, '/home/user/mount'), false)
  assert.equal(mountinfoContains(text, '/home/user/mount-two'), false)
})
test('server settings persist atomically without runtime status and reload disconnected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-manager-test-'))
  const ctx = new Context()
  const options = { stateDir: join(directory, 'state'), mountRoot: join(directory, 'mounts') }
  let manager: SshWorkspaceManager | undefined
  try {
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    const state = await manager.upsertServer(server)
    assert.equal(state.servers.length, 1)
    const id = state.servers[0]!.id
    assert.equal(state.servers[0]!.status, 'disconnected')
    state.servers[0]!.label = 'external mutation'
    assert.equal(manager.state().servers[0]!.label, 'Training host')
    await manager.dispose()
    const disk = JSON.parse(await readFile(join(options.stateDir, 'state.json'), 'utf8'))
    assert.equal(disk.servers[0].status, undefined)
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    assert.equal(manager.state().servers[0]!.id, id)
    await manager.upsertServer({ ...server, id, label: 'Renamed' })
    assert.equal(manager.state().servers[0]!.label, 'Renamed')
    await manager.removeServer(id)
    assert.equal(manager.state().servers.length, 0)
  } finally {
    await manager?.dispose()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
test('restored offline workspaces remain routed and use a dangling marker, never an empty local directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-offline-test-'))
  const ctx = new Context()
  const options = { stateDir: join(directory, 'state'), mountRoot: join(directory, 'mounts') }
  const serverId = '67fdcd3d-e2c6-4c07-bac2-8ab96bd73bac'
  const workspaceId = '7c19d4cd-2728-4edb-9a9e-1ec67b57273a'
  let manager: SshWorkspaceManager | undefined
  try {
    await mkdir(options.stateDir, { recursive: true })
    await writeFile(join(options.stateDir, 'state.json'), JSON.stringify({ version: 1,
      servers: [{...serverInput.parse(server), id: serverId}],
      workspaces: [{ id: workspaceId, serverId, title: 'Training', remotePath: '/data/train', mountPath: join(options.mountRoot, workspaceId) }],
    }))
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    const mapping = manager.listMounts()[0]!
    assert.equal(mapping.status, 'unmounted')
    assert.equal(manager.getRemote(serverId), undefined)
    assert.match(await readlink(mapping.localPath), /offline-not-mounted/u)
    await assert.rejects(mkdir(mapping.localPath, { recursive: true }))
  } finally {
    await manager?.dispose()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
test('deleted workspace keeps a durable blocked route after server removal and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-retired-test-'))
  const ctx = new Context()
  const options = { stateDir: join(directory, 'state'), mountRoot: join(directory, 'mounts') }
  const serverId = '67fdcd3d-e2c6-4c07-bac2-8ab96bd73bac'
  const workspaceId = '7c19d4cd-2728-4edb-9a9e-1ec67b57273a'
  const mountPath = join(options.mountRoot, workspaceId)
  let manager: SshWorkspaceManager | undefined
  try {
    await mkdir(options.stateDir, { recursive: true })
    // v1 files without retiredMounts continue to load with an empty tombstone list.
    await writeFile(join(options.stateDir, 'state.json'), JSON.stringify({ version: 1,
      servers: [{...serverInput.parse(server), id: serverId}],
      workspaces: [{ id: workspaceId, serverId, title: 'Training', remotePath: '/data/train', mountPath }],
    }))
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    await manager.removeWorkspace(workspaceId)
    assert.equal(manager.state().workspaces.length, 0)
    assert.equal(manager.listMounts()[0]!.localPath, mountPath)
    assert.equal(manager.listMounts()[0]!.status, 'unmounted')
    await manager.removeServer(serverId)
    assert.equal(manager.state().servers.length, 0)
    assert.equal(manager.getRemote(serverId), undefined)
    await assert.rejects(mkdir(mountPath, { recursive: true }))
    await manager.dispose()
    const disk = JSON.parse(await readFile(join(options.stateDir, 'state.json'), 'utf8'))
    assert.equal(disk.retiredMounts.length, 1)
    assert.equal(disk.retiredMounts[0].mountPath, mountPath)
    manager = new SshWorkspaceManager(ctx, options)
    await manager.ready
    assert.deepEqual(manager.state(), { servers: [], workspaces: [] })
    assert.equal(manager.listMounts().length, 1)
    assert.equal(manager.listMounts()[0]!.status, 'unmounted')
    assert.deepEqual(manager.listMounts()[0]!.hostExecutables, [])
    assert.deepEqual(manager.listMounts()[0]!.executableMap, {})
    assert.equal(manager.getRemote(serverId), undefined)
    await assert.rejects(mkdir(mountPath, { recursive: true }))
    assert.match(await readlink(mountPath), /offline-not-mounted/u)
  } finally {
    await manager?.dispose()
    await ctx.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
