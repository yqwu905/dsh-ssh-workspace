import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Context, Service } from '@deepseek-ai/cordis';
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox';
import { findMount, installRouting, isHostRuntime, mapArgument, mapArgv, mapExecutable, mapPath, mapShellCommand } from '../src/routing.ts';
import type { MountedWorkspace, RemoteProviders } from '../src/routing.ts';

const mount: MountedWorkspace = { serverId: 'gpu', localPath: '/mnt/project', remotePath: '/data/project', status: 'mounted' };

test('longest path-boundary route and canonical path mapping', () => {
  const deeper = { ...mount, localPath: '/mnt/project/nested', remotePath: '/other' };
  assert.equal(findMount('/mnt/project/nested/x', [mount, deeper]), deeper);
  assert.equal(findMount('/mnt/project-old', [mount]), undefined);
  assert.equal(findMount('/mnt/project/../private', [mount]), undefined);
  assert.equal(mapPath('/mnt/project/sub/file', mount), '/data/project/sub/file');
  assert.equal(mapPath('/mnt/project2/sub', mount), '/mnt/project2/sub');
  assert.equal(mapArgument('--dir=/mnt/project/sub', mount), '--dir=/data/project/sub');
  assert.equal(mapArgument('data /mnt/project', mount), 'data /mnt/project');
});

test('literal shell prefixes retain quoting, spaces and shell metacharacters', () => {
  const special = { ...mount, remotePath: '/data/space name/\'"$(`)\\end' };
  for (const source of [
    "printf '%s' /mnt/project/sub",
    "printf '%s' '/mnt/project/sub'",
    'printf \'%s\' "/mnt/project/sub"',
  ]) {
    const translated = mapShellCommand(source, special);
    assert.equal(execFileSync('bash', ['-c', translated], { encoding: 'utf8' }), special.remotePath + '/sub');
  }
  assert.equal(mapShellCommand('cat /mnt/project2/x', mount), 'cat /mnt/project2/x');
  assert.throws(() => mapShellCommand('cat <<EOF\n/mnt/project\nEOF', mount), /heredocs/);
  assert.throws(() => mapShellCommand('echo $(cat /mnt/project/x)', mount), /substitutions/);
});

test('argv maps literal operands and known shell command arguments without reinterpreting argv', () => {
  assert.deepEqual(mapArgv(['/bin/bash', '-lc', 'cat "/mnt/project/a b"'], mount), ['bash', '-lc', 'cat "/data/project/a b"']);
  assert.deepEqual(mapArgv(['python', '/mnt/project/a b.py', '--dir=/mnt/project'], mount), ['python', '/data/project/a b.py', '--dir=/data/project']);
  assert.equal(mapExecutable('/host/node_modules/@vscode/ripgrep/bin/rg', mount), 'rg');
  assert.equal(mapExecutable('/host/bin/unknown', mount), '/host/bin/unknown');
  assert.equal(mapExecutable('/host/bin/unknown', { ...mount, executableMap: { '/host/bin/unknown': '/remote/known' } }), '/remote/known');
});

test('host PTC exception is exact package path and exact invocation, not a substring pattern', () => {
  const bootstrap = '/host/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js';
  assert.equal(isHostRuntime(['/bin/node', '--max-old-space-size=128', bootstrap, '4096'], [], [bootstrap]), true);
  assert.equal(isHostRuntime(['/bin/node', '--eval', bootstrap, '4096'], [], [bootstrap]), false);
  assert.equal(isHostRuntime(['/bin/node', '--max-old-space-size=128', '/tmp/like/process.js', '4096'], [], [bootstrap]), false);
  assert.equal(isHostRuntime(['/opt/tool', 'x'], ['/opt/tool']), true);
});

function harness(initialMounts: MountedWorkspace[] = [mount], failures: { host?: Error; remote?: Error } = {}) {
  const calls: Array<{ kind: string; spec: any }> = [];
  const handle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true };
  const facts = (argv: readonly string[]) => ({ argv: ['runner', ...argv], enforcement: 'full' as const, denialSignatures: ['denied'], runnerFailureRules: [] });
  const local: any = {
    spawn(spec: unknown) { calls.push({ kind: 'local', spec }); return handle; },
    async spawnTerminal(spec: unknown) { calls.push({ kind: 'local-terminal', spec }); return handle; },
  };
  const sandbox: any = { async confine(argv: string[], policy: unknown) { calls.push({ kind: 'local-confine', spec: { argv, policy } }); if (failures.host) throw failures.host; return facts(argv); } };
  const remote: RemoteProviders = {
    subprocess: {
      spawn(spec) { calls.push({ kind: 'remote', spec }); return handle; },
      async spawnTerminal(spec) { calls.push({ kind: 'remote-terminal', spec }); return handle as any; },
      async resolveExecutable(program) { return '/remote/bin/' + program; },
    },
    sandbox: { async confine(argv, policy) { calls.push({ kind: 'remote-confine', spec: { argv, policy } }); if (failures.remote) throw failures.remote; return facts(argv); } },
  };
  let mounts = initialMounts;
  let provider: RemoteProviders | undefined = remote;
  const ctx: any = { subprocess: local, sandbox, effect(callback: () => () => void) { return callback(); } };
  const originalSpawn = local.spawn;
  const dispose = installRouting(ctx, { listMounts: () => mounts, getRemote: () => provider });
  const spec = { argv: ['bash', '-c', 'pwd'], cwd: mount.localPath, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 };
  return { ctx, calls, spec, dispose, originalSpawn, setMounts(value: MountedWorkspace[]) { mounts = value; }, offline() { provider = undefined; }, reconnect() { provider = { ...remote }; } };
}

test('failed remote confinement identifies the server and cannot fall back to host execution', async () => {
  const error = new SandboxUnavailableError('workspace-write', new SandboxUnavailableError('workspace-write').message);
  const h = harness([{ ...mount, host: 'gpu-alias' }], { remote: error });
  try {
    await assert.rejects(h.ctx.sandbox.confine(['bash', '-c', 'pwd'], { mode: 'workspace-write', workspaceRoot: mount.localPath }), (failure: any) => {
      assert.equal(failure.code, SANDBOX_UNAVAILABLE);
      assert.match(failure.message, /SSH server gpu-alias.*remote workspace \/data\/project/u);
      assert.doesNotMatch(failure.message, /Runner failure:/u);
      return true;
    });
    assert.deepEqual(h.calls.map(call => call.kind), ['remote-confine']);
    assert.equal(h.calls[0]!.spec.policy.mode, 'workspace-write');
  } finally { await h.dispose(); }
});

test('Host exceptions report Host confinement failures, not the remote server', async () => {
  const h = harness([{ ...mount, hostExecutables: ['/host/tool'] }], { host: new SandboxUnavailableError('workspace-write') });
  try {
    await assert.rejects(h.ctx.sandbox.confine(['/host/tool'], { mode: 'workspace-write', workspaceRoot: mount.localPath }), /DSH Host \(PTC worker or hostExecutables exception/u);
    await assert.rejects(h.ctx.sandbox.confine(['bash'], { mode: 'workspace-write', workspaceRoot: '/host/project' }), /DSH Host \(workspace \/host\/project/u);
    assert.deepEqual(h.calls.map(call => call.kind), ['local-confine', 'local-confine']);
  } finally { await h.dispose(); }
});

test('routes only mounted cwd; preserves stdio, cancellation and local behavior', async () => {
  const h = harness();
  const signal = new AbortController().signal;
  const remoteHandle = h.ctx.subprocess.spawn({ ...h.spec, signal, cwd: '/mnt/project/sub', env: { DSH_WORKSPACE: '/mnt/project', OMITTED: undefined } });
  assert.equal(await remoteHandle.waitForExit(), true);
  assert.equal(h.calls[0]?.kind, 'remote');
  assert.equal(h.calls[0]?.spec.cwd, '/data/project/sub');
  assert.equal(h.calls[0]?.spec.env.DSH_WORKSPACE, '/data/project');
  assert.equal(h.calls[0]?.spec.signal, signal);
  assert.equal(h.calls[0]?.spec.stdio, h.spec.stdio);
  h.ctx.subprocess.spawn({ ...h.spec, cwd: '/host/project' });
  assert.equal(h.calls[1]?.kind, 'local');
  await h.dispose();
  assert.equal(h.ctx.subprocess.spawn, h.originalSpawn);
});

test('offline or unmounted workspace fails closed even with a live server', () => {
  const h = harness();
  h.setMounts([{ ...mount, status: 'unmounted' }]);
  assert.throws(() => h.ctx.subprocess.spawn(h.spec), /refusing local/);
  h.setMounts([mount]);
  h.offline();
  assert.throws(() => h.ctx.subprocess.spawn(h.spec), /refusing local/);
  assert.equal(h.calls.length, 0);
  h.dispose();
});

test('remote sandbox preserves mode and metadata; its exact argv is not translated twice', async () => {
  const h = harness();
  const policy = { mode: 'read-only', workspaceRoot: mount.localPath, sessionId: 's1' };
  const confined = await h.ctx.sandbox.confine(['bash', '-c', 'cat /mnt/project/file'], policy);
  assert.equal(h.calls[0]?.kind, 'remote-confine');
  assert.deepEqual(h.calls[0]?.spec.policy, { ...policy, workspaceRoot: '/data/project' });
  assert.equal(confined.enforcement, 'full');
  h.ctx.subprocess.spawn({ ...h.spec, argv: confined.argv });
  assert.equal(h.calls[1]?.spec.argv, confined.argv);
  h.reconnect();
  assert.throws(() => h.ctx.subprocess.spawn({ ...h.spec, argv: confined.argv }), /connection changed/);
  h.dispose();
});

test('local confinement cannot be reused to execute a remote cwd', async () => {
  const h = harness();
  const confined = await h.ctx.sandbox.confine(['bash', '-c', 'pwd'], { mode: 'workspace-write', workspaceRoot: '/host/project' });
  assert.throws(() => h.ctx.subprocess.spawn({ ...h.spec, argv: confined.argv }), /host sandbox/);
  h.dispose();
});

test('explicit host exception retains host cwd and original host sandbox', async () => {
  const h = harness([{ ...mount, hostExecutables: ['/host/tool'] }]);
  const confined = await h.ctx.sandbox.confine(['/host/tool', 'arg'], { mode: 'workspace-write', workspaceRoot: mount.localPath });
  assert.equal(h.calls[0]?.kind, 'local-confine');
  h.ctx.subprocess.spawn({ ...h.spec, argv: confined.argv });
  assert.equal(h.calls[1]?.kind, 'local');
  assert.equal(h.calls[1]?.spec.cwd, mount.localPath);
  h.dispose();
});

test('intercepts real Cordis service consumers and restores the provider on plugin unload', async () => {
  const calls: string[] = [];
  const handle = { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined, collected: {}, done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true };
  class Provider extends Service {
    constructor(ctx: Context) { super(ctx, 'subprocess'); }
    spawn(_spec: unknown) { calls.push('host'); return handle; }
    async spawnTerminal(_spec: unknown) { calls.push('host-terminal'); return handle; }
  }
  class Sandbox extends Service {
    constructor(ctx: Context) { super(ctx, 'sandbox'); }
    async confine(argv: string[]) { return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }; }
  }
  const ctx = new Context();
  const fibers: any[] = [];
  try {
    fibers.push(await ctx.plugin(Provider), await ctx.plugin(Sandbox));
    const remote = { subprocess: { spawn() { calls.push('remote'); return handle; } }, sandbox: {} } as unknown as RemoteProviders;
    const router = await ctx.plugin({
      name: 'test-router', inject: ['subprocess', 'sandbox'],
      apply(scope: Context) { installRouting(scope, { listMounts: () => [mount], getRemote: () => remote }); },
    });
    fibers.push(router);
    const consume = await ctx.plugin({
      name: 'test-consumer', inject: ['subprocess'],
      apply(scope: Context) {
        scope.subprocess.spawn({ argv: ['bash', '-c', 'pwd'], cwd: mount.localPath, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 });
      },
    });
    fibers.push(consume);
    assert.deepEqual(calls, ['remote']);
    await router.dispose();
    ctx.subprocess.spawn({ argv: ['bash', '-c', 'pwd'], cwd: mount.localPath, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 });
    assert.deepEqual(calls, ['remote', 'host']);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
});
