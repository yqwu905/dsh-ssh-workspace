/** Native SSH file operations behind host mount coordinates used by DSH Web. */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FsError, FsTargetKey } from '@deepseek-ai/dsh-fs';
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs';
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import { findMount, isWithin, mapPath } from './routing.js';
import type { MountedWorkspace, RemoteProviders, RoutingManager } from './routing.js';

export interface FsRemoteProviders extends RemoteProviders { readonly fs: FileSystem }
export interface FsRoutingManager extends RoutingManager {
  getRemote(serverId: string): FsRemoteProviders | undefined;
}
type FsRoutingContext = Pick<Context, 'effect'> & {
  fs: FileSystem;
  sandboxPolicy: Pick<SandboxPolicyService, 'resolve'>;
};
type Methods = 'resolve' | 'processPath' | 'processPathFromHostPath' | 'fileUrl' | 'contains'
  | 'stat' | 'lstat' | 'readText' | 'streamText' | 'readBytes' | 'readByteRange' | 'listDir'
  | 'writeText' | 'editText' | 'watch';
type RoutedTarget = { mount: MountedWorkspace; remote: FsRemoteProviders; native: FsTarget; path: string };
const targetPrefix = 'dsh-ssh-workspace:';

/**
 * File tools use one native RPC path, preserving atomic version-guarded writes.
 * SSHFS remains the interoperability path for WorkspaceRegistry and trusted
 * plugins that call node:fs directly. Such direct calls do not use this fence.
 */
export function installFsRouting(ctx: FsRoutingContext, manager: FsRoutingManager): () => void | Promise<void> {
  const fs = (Reflect.get(ctx.fs, Symbol.for('cordis.original')) ?? ctx.fs) as FileSystem;
  const names: Methods[] = ['resolve', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains',
    'stat', 'lstat', 'readText', 'streamText', 'readBytes', 'readByteRange', 'listDir', 'writeText', 'editText', 'watch'];
  const originals = Object.fromEntries(names.map(name => [name, fs[name]])) as Pick<FileSystem, Methods>;
  const descriptors = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(fs, name)]));
  const generations = new WeakMap<object, string>();
  const targets = new Map<string, RoutedTarget>();
  let active = true;

  function local<K extends Methods>(name: K, receiver: object, ...args: Parameters<FileSystem[K]>): ReturnType<FileSystem[K]> {
    return Reflect.apply(originals[name], receiver, args) as ReturnType<FileSystem[K]>;
  }
  function ready(mount: MountedWorkspace): FsRemoteProviders {
    const live = manager.listMounts().find(candidate => candidate.serverId === mount.serverId
      && candidate.localPath === mount.localPath && candidate.remotePath === mount.remotePath);
    const remote = manager.getRemote(mount.serverId);
    if (live === undefined || live.status !== undefined && live.status !== 'mounted' || remote === undefined) {
      throw new FsError(`SSH workspace ${mount.localPath} is offline; reconnect before accessing its files.`, 'FS_IO_ERROR');
    }
    return remote;
  }
  function current(value: RoutedTarget): RoutedTarget {
    const mount = manager.listMounts().find(candidate => candidate.serverId === value.mount.serverId && candidate.localPath === value.mount.localPath);
    if (mount === undefined || ready(mount) !== value.remote) {
      throw new FsError('SSH connection or workspace changed; resolve the file again before continuing.', 'FS_IO_ERROR');
    }
    return value;
  }
  function selected(path: string, cwd?: string): { mount: MountedWorkspace; remote: FsRemoteProviders; path: string; cwd?: string } | undefined {
    const absolute = posix.isAbsolute(path) ? path : cwd === undefined ? undefined : posix.resolve(cwd, path);
    const mount = absolute === undefined ? undefined : findMount(absolute, manager.listMounts());
    const cwdMount = cwd === undefined ? undefined : findMount(cwd, manager.listMounts());
    if (!posix.isAbsolute(path) && cwdMount !== undefined && mount?.localPath !== cwdMount.localPath) {
      throw new FsError('Relative file path crosses an SSH workspace boundary. Use its registered absolute mount path.', 'FS_PERMISSION_DENIED');
    }
    if (mount === undefined) {
      // A relative '..' escape from an SSH workspace must not turn into a host operation.
      if (!posix.isAbsolute(path) && cwd !== undefined && findMount(cwd, manager.listMounts()) !== undefined) {
        throw new FsError('Relative file path escapes the SSH workspace. Choose an explicitly registered workspace.', 'FS_PERMISSION_DENIED');
      }
      return undefined;
    }
    const remote = ready(mount);
    // Keep the relative spelling so the remote FS preserves symlink/.. semantics.
    return { mount, remote, path: posix.isAbsolute(path) ? mapPath(path, mount) : path,
      ...(cwd === undefined ? {} : { cwd: mapPath(cwd, mount) }) };
  }
  function wrap(native: FsTarget, mount: MountedWorkspace, remote: FsRemoteProviders): FsTarget {
    const remotePath = remote.fs.processPath(native);
    if (!posix.isAbsolute(remotePath) || !isWithin(remotePath, mount.remotePath)) {
      throw new FsError(`Remote path resolves outside the registered workspace ${mount.remotePath}; symlink escapes are not exposed through its host mount.`, 'FS_PERMISSION_DENIED');
    }
    let generation = generations.get(remote);
    if (generation === undefined) { generation = randomUUID(); generations.set(remote, generation); }
    const key = targetPrefix + JSON.stringify([mount.serverId, generation, native.targetKey]);
    const path = posix.join(mount.localPath, posix.relative(mount.remotePath, remotePath));
    targets.set(key, { mount, remote, native, path });
    return { targetKey: FsTargetKey(key), displayPath: path };
  }
  function target(value: FsTarget): RoutedTarget | undefined {
    const found = targets.get(String(value.targetKey));
    if (found !== undefined) return current(found);
    if (String(value.targetKey).startsWith(targetPrefix)) throw new FsError('Unknown or retired SSH file target; resolve the file again.', 'FS_IO_ERROR');
    const path = Reflect.apply(originals.processPath, fs, [value]) as string;
    if (findMount(path, manager.listMounts()) !== undefined) {
      throw new FsError('A pre-routing file target cannot access an SSH mount; resolve the file again.', 'FS_IO_ERROR');
    }
    return undefined;
  }
  function policy(value: RoutedTarget, supplied?: SandboxExecutionPolicy): SandboxExecutionPolicy {
    const effective = supplied ?? ctx.sandboxPolicy.resolve();
    const owner = findMount(effective.workspaceRoot, manager.listMounts());
    if (owner !== undefined && owner.serverId === value.mount.serverId) {
      if (ready(owner) !== value.remote) throw new FsError('Sandbox and file use different SSH connections.', 'FS_IO_ERROR');
      return { ...effective, workspaceRoot: mapPath(effective.workspaceRoot, owner) };
    }
    if (effective.mode === 'workspace-write') {
      throw new FsError('The file policy workspace is not on this SSH server; refusing mutation.', 'FS_SANDBOX_DENIED');
    }
    // Root is unused by read-only/full-access, but must still name this execution world.
    return { ...effective, workspaceRoot: value.mount.remotePath };
  }

  const wrappers: Pick<FileSystem, Methods> = {
    async resolve(path, opts) {
      if (!active) return local('resolve', this, path, opts);
      const route = selected(path, opts?.cwd);
      if (route === undefined) return local('resolve', this, path, opts);
      const native = await route.remote.fs.resolve(route.path, { cwd: route.cwd, signal: opts?.signal });
      if (ready(route.mount) !== route.remote) throw new FsError('SSH connection changed during file resolution; retry.', 'FS_IO_ERROR');
      return wrap(native, route.mount, route.remote);
    },
    processPath(value) {
      if (!active) return local('processPath', this, value);
      return target(value)?.path ?? local('processPath', this, value);
    },
    processPathFromHostPath(path) {
      if (active) {
        const mount = findMount(path, manager.listMounts());
        if (mount !== undefined) { ready(mount); return path; }
      }
      return local('processPathFromHostPath', this, path);
    },
    fileUrl(value) {
      if (!active) return local('fileUrl', this, value);
      const route = target(value);
      return route === undefined ? local('fileUrl', this, value) : pathToFileURL(route.path).href;
    },
    contains(parent, child) {
      if (!active) return local('contains', this, parent, child);
      const a = target(parent), b = target(child);
      if (a === undefined && b === undefined) return local('contains', this, parent, child);
      return a !== undefined && b !== undefined && a.mount.serverId === b.mount.serverId
        && a.remote === b.remote && a.remote.fs.contains(a.native, b.native);
    },
    async stat(value, signal) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('stat', this, value, signal) : route.remote.fs.stat(route.native, signal);
    },
    async lstat(path, opts, signal) {
      const route = active ? selected(path, opts?.cwd) : undefined;
      if (route === undefined) return local('lstat', this, path, opts, signal);
      // Resolve only the parent: expose symlink metadata but never traverse a parent escape.
      const absolute = posix.isAbsolute(route.path) ? route.path : (route.cwd ?? route.mount.remotePath) + '/' + route.path;
      if (absolute === route.mount.remotePath) return route.remote.fs.lstat(absolute, undefined, signal);
      const parent = await route.remote.fs.resolve(posix.dirname(absolute), { signal });
      wrap(parent, route.mount, route.remote);
      return route.remote.fs.lstat(posix.join(route.remote.fs.processPath(parent), posix.basename(absolute)), undefined, signal);
    },
    async readText(value, signal) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('readText', this, value, signal) : route.remote.fs.readText(route.native, signal);
    },
    async streamText(value, signal) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('streamText', this, value, signal) : route.remote.fs.streamText(route.native, signal);
    },
    async readBytes(value, signal, maxBytes) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('readBytes', this, value, signal, maxBytes) : route.remote.fs.readBytes(route.native, signal, maxBytes);
    },
    async readByteRange(value, range, signal) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('readByteRange', this, value, range, signal) : route.remote.fs.readByteRange(route.native, range, signal);
    },
    async listDir(value, signal) {
      const route = active ? target(value) : undefined;
      if (route === undefined) return local('listDir', this, value, signal);
      const entries = await route.remote.fs.listDir(route.native, signal);
      current(route);
      return entries.map(entry => ({ ...entry, target: wrap(entry.target, route.mount, route.remote) }));
    },
    async writeText(value, content, expected, signal, supplied) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('writeText', this, value, content, expected, signal, supplied)
        : route.remote.fs.writeText(route.native, content, expected, signal, policy(route, supplied));
    },
    async editText(value, edit, expected, signal, supplied) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('editText', this, value, edit, expected, signal, supplied)
        : route.remote.fs.editText(route.native, edit, expected, signal, policy(route, supplied));
    },
    async watch(value, changed, signal) {
      const route = active ? target(value) : undefined;
      return route === undefined ? local('watch', this, value, changed, signal) : route.remote.fs.watch(route.native, changed, signal);
    },
  };
  return ctx.effect(() => {
    for (const name of names) Object.defineProperty(fs, name, { configurable: true, writable: true, value: wrappers[name] });
    return () => {
      active = false;
      for (const name of names) {
        if (Reflect.get(fs, name) !== wrappers[name]) continue;
        const descriptor = descriptors.get(name);
        if (descriptor === undefined) Reflect.deleteProperty(fs, name);
        else Object.defineProperty(fs, name, descriptor);
      }
      targets.clear();
    };
  }, 'ssh-workspaces.fs-routing');
}
