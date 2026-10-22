import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox';
import { installFsRouting } from '../src/fs-routing.ts';
import type { FsRemoteProviders } from '../src/fs-routing.ts';
import type { MountedWorkspace } from '../src/routing.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-fs-route-'));
  const remoteRoot = join(directory, 'remote');
  const outside = join(directory, 'outside');
  await mkdir(remoteRoot); await mkdir(outside);
  await writeFile(join(remoteRoot, 'a.txt'), 'hello world');
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await writeFile(join(directory, 'local.txt'), 'host');
  await symlink(join(remoteRoot, 'a.txt'), join(remoteRoot, 'alias.txt'));
  await symlink(outside, join(remoteRoot, 'escape'));
  const mount: MountedWorkspace = { serverId: 'gpu1', localPath: '/dsh-test-mount/project', remotePath: remoteRoot, status: 'mounted' };
  const host = new Context(), remote = new Context();
  class Policy extends Service {
    readonly defaultMode = 'workspace-write';
    constructor(ctx: Context) { super(ctx, 'sandboxPolicy'); }
    resolve() { return { mode: 'workspace-write' as const, workspaceRoot: mount.localPath }; }
  }
  const fibers = [await host.plugin(Policy), await host.plugin(LocalFileSystem), await remote.plugin(Policy), await remote.plugin(SandboxedFileSystem)];
  let providers: FsRemoteProviders | undefined = { fs: remote.fs, subprocess: {} as any, sandbox: {} as any };
  let mounts = [mount];
  const dispose = installFsRouting(host, { listMounts: () => mounts, getRemote: () => providers });
  return {
    fs: host.fs, directory, remoteRoot, mount,
    offline() { providers = undefined; },
    reconnect() { providers = { ...providers! }; },
    twoServers() { mounts = [mount, { ...mount, serverId: 'gpu2', localPath: '/dsh-test-mount/other' }]; },
    async close() { await dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('native FS keeps host coordinates but uses server-qualified canonical target identity', async () => {
  const f = await fixture();
  try {
    const target = await f.fs.resolve('a.txt', { cwd: f.mount.localPath });
    const alias = await f.fs.resolve(f.mount.localPath + '/alias.txt');
    assert.equal(target.targetKey, alias.targetKey);
    assert.equal(f.fs.processPath(target), f.mount.localPath + '/a.txt');
    assert.equal(target.displayPath, f.mount.localPath + '/a.txt');
    assert.equal(f.fs.fileUrl(target), 'file://' + f.mount.localPath + '/a.txt');
    assert.equal(await f.fs.readText(target), 'hello world');
    assert.deepEqual(Buffer.from(await f.fs.readByteRange(target, { offset: 6, length: 5 })).toString(), 'world');
    assert.equal(Buffer.from(await f.fs.readBytes(target, undefined, 100)).toString(), 'hello world');
    let streamed = ''; for await (const chunk of await f.fs.streamText(target)) streamed += chunk;
    assert.equal(streamed, 'hello world');
    const host = await f.fs.resolve(join(f.directory, 'local.txt'));
    assert.equal(await f.fs.readText(host), 'host');
    assert.equal(f.fs.contains(host, target), false);
    f.twoServers();
    const other = await f.fs.resolve('/dsh-test-mount/other/a.txt');
    assert.notEqual(other.targetKey, target.targetKey);
    assert.equal(f.fs.contains(target, other), false);
  } finally { await f.close(); }
});

test('writes and edits retain native stale guards and enforce the exact per-call mode', async () => {
  const f = await fixture();
  try {
    const target = await f.fs.resolve(f.mount.localPath + '/a.txt');
    const original = await f.fs.stat(target);
    assert.ok(original);
    const write = await f.fs.writeText(target, 'new value', { kind: 'replaceIfVersion', version: original.version });
    assert.equal(await readFile(join(f.remoteRoot, 'a.txt'), 'utf8'), 'new value');
    await assert.rejects(f.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: original.version }), { code: 'FS_STALE_VERSION' });
    await assert.rejects(f.fs.writeText(target, 'forbidden', undefined, undefined, { mode: 'read-only', workspaceRoot: f.mount.localPath }), { code: 'FS_SANDBOX_DENIED' });
    await assert.rejects(f.fs.writeText(target, 'forbidden', undefined, undefined, { mode: 'workspace-write', workspaceRoot: '/host/other' }), { code: 'FS_SANDBOX_DENIED' });
    await f.fs.editText(target, { oldString: 'value', newString: 'content', replaceAll: false }, { version: write.version });
    assert.equal(await f.fs.readText(target), 'new content');
  } finally { await f.close(); }
});

test('symlink escapes and relative host escapes fail closed; lstat may report a final symlink', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.fs.resolve(f.mount.localPath + '/escape/secret.txt'), { code: 'FS_PERMISSION_DENIED' });
    await assert.rejects(f.fs.resolve('../host.txt', { cwd: f.mount.localPath }), { code: 'FS_PERMISSION_DENIED' });
    assert.equal((await f.fs.lstat(f.mount.localPath + '/escape'))?.type, 'symlink');
    assert.equal((await f.fs.lstat(f.mount.localPath))?.type, 'directory');
    await assert.rejects(f.fs.lstat(f.mount.localPath + '/escape/secret.txt'), { code: 'FS_PERMISSION_DENIED' });
    const root = await f.fs.resolve(f.mount.localPath);
    await assert.rejects(f.fs.listDir(root), { code: 'FS_PERMISSION_DENIED' });
  } finally { await f.close(); }
});

test('file targets cannot silently cross disconnect or connection replacement', async () => {
  const f = await fixture();
  try {
    const target = await f.fs.resolve(f.mount.localPath + '/a.txt');
    f.reconnect();
    await assert.rejects(f.fs.readText(target), { code: 'FS_IO_ERROR' });
    const replacement = await f.fs.resolve(f.mount.localPath + '/a.txt');
    assert.notEqual(replacement.targetKey, target.targetKey);
    f.offline();
    await assert.rejects(f.fs.readText(replacement), { code: 'FS_IO_ERROR' });
    await assert.rejects(f.fs.resolve(f.mount.localPath + '/a.txt'), { code: 'FS_IO_ERROR' });
  } finally { await f.close(); }
});
