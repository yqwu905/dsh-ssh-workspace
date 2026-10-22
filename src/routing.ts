/** Route subprocesses over the native DSH SSH providers while SSHFS serves files. */
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessRuntime, SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { SandboxProvider, SandboxPolicy } from '@deepseek-ai/dsh-sandbox';

export interface MountedWorkspace {
  readonly serverId: string;
  readonly localPath: string;
  readonly remotePath: string;
  readonly status?: 'mounted' | 'unmounted' | 'mounting' | 'error';
  /** Exact executable spelling on the host -> remote executable/path. */
  readonly executableMap?: Readonly<Record<string, string>>;
  /** Deliberate exceptions that remain on the host, including their sandbox. */
  readonly hostExecutables?: readonly string[];
}

export interface RemoteProviders {
  readonly subprocess: Pick<SubprocessRuntime, 'spawn' | 'spawnTerminal' | 'resolveExecutable'>;
  readonly sandbox: Pick<SandboxProvider, 'confine'>;
}

export interface RoutingManager {
  /** Include offline records: a disconnected workspace must never fall through locally. */
  listMounts(): readonly MountedWorkspace[];
  /** Synchronous readiness lookup. Providers are published only after SSH readiness. */
  getRemote(serverId: string): RemoteProviders | undefined;
}

function root(path: string): string {
  if (!posix.isAbsolute(path) || path.includes('\0')) throw new Error('SSH workspace paths must be absolute POSIX paths without NUL');
  return posix.normalize(path).replace(/\/$/, '') || '/';
}

export function isWithin(path: string, parent: string): boolean {
  const relative = posix.relative(root(parent), root(path));
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative));
}

/** Longest enclosing mount wins; sibling names and lexical '..' never collide. */
export function findMount(path: string, mounts: readonly MountedWorkspace[]): MountedWorkspace | undefined {
  if (!posix.isAbsolute(path)) return undefined;
  return mounts.filter(mount => isWithin(path, mount.localPath))
    .sort((a, b) => root(b.localPath).length - root(a.localPath).length)[0];
}

export function mapPath(path: string, mount: MountedWorkspace): string {
  if (!posix.isAbsolute(path) || !isWithin(path, mount.localPath)) return path;
  const prefix = root(mount.localPath);
  if (path !== prefix && !path.startsWith(prefix === '/' ? '/' : prefix + '/')) {
    throw new Error('Use the canonical workspace mount prefix; aliased prefix traversal cannot be translated safely.');
  }
  // Do not collapse symlink/.. in the suffix: only the remote filesystem can interpret it.
  const suffix = path.slice(prefix.length);
  const remote = root(mount.remotePath);
  return prefix === '/' ? posix.join(remote, suffix) : (remote === '/' ? suffix || '/' : remote + suffix);
}

function shellLiteral(text: string, quote: '' | "'" | '"'): string {
  if (quote === "'") return text.replaceAll("'", "'\\''");
  if (quote === '"') return text.replace(/[\\$`\"]/g, '\\$&');
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

function pathEnd(character: string | undefined): boolean {
  return character === undefined || character === '/' || /[\s'";|&()<>]/.test(character);
}

/**
 * Translate literal mount prefixes in ordinary POSIX shell source. This is
 * deliberately not a shell rewriter: heredocs, substitutions and escaped mount
 * spellings require relative paths or the remote path supplied by the panel.
 * Rejecting those cases avoids changing the meaning of nested code/quoting.
 */
export function mapShellCommand(command: string, mount: MountedWorkspace): string {
  const local = root(mount.localPath);
  if (!command.includes(local)) return command;
  if (command.includes('<<') || command.includes('$(') || command.includes('`')) {
    throw new Error('SSH path translation does not rewrite heredocs or command substitutions. Use a relative path from the workspace or its remote absolute path.');
  }
  let quote: '' | "'" | '"' = '';
  let output = '';
  for (let index = 0; index < command.length;) {
    const character = command[index]!;
    if (character === '\\' && quote !== "'") {
      if (command.startsWith(local, index + 1)) {
        throw new Error('Use a quoted or relative workspace path instead of an escaped mount prefix.');
      }
      output += command.slice(index, index + 2);
      index += 2;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? '' : character;
      output += character;
      index++;
      continue;
    }
    const previous = command[index - 1];
    const startBoundary = index === 0 || previous !== undefined && /[\s='";|&()<>:]/.test(previous);
    if (startBoundary && command.startsWith(local, index) && pathEnd(command[index + local.length])) {
      output += shellLiteral(root(mount.remotePath), quote);
      index += local.length;
      continue;
    }
    output += character;
    index++;
  }
  if (quote) throw new Error('Cannot translate workspace paths in shell source with an unterminated quote.');
  return output;
}

/** Translate path operands, retaining unrelated literal data and sibling paths. */
export function mapArgument(argument: string, mount: MountedWorkspace): string {
  if (posix.isAbsolute(argument)) return mapPath(argument, mount);
  const equals = argument.indexOf('=');
  if (equals >= 0 && argument.startsWith('-')) {
    return argument.slice(0, equals + 1) + mapPath(argument.slice(equals + 1), mount);
  }
  return argument;
}

/** No basename fallback for arbitrary host-installed binaries. Missing remote files fail loudly. */
export function mapExecutable(program: string, mount: MountedWorkspace): string {
  const explicit = mount.executableMap?.[program];
  if (explicit !== undefined) {
    if (explicit.length === 0 || explicit.includes('\0')) throw new Error('An executableMap target must be a nonempty executable name or absolute path');
    return explicit;
  }
  if (isWithinIfAbsolute(program, mount.localPath)) return mapPath(program, mount);
  // DSH's bundled ripgrep is platform-specific and cannot be executed remotely.
  if (/\/(?:@vscode\/ripgrep|@vscode\+ripgrep[^/]*)\/.+\/rg$/.test(program)) return 'rg';
  // The actual provider resolves the remote PATH; do not export host Homebrew paths.
  if (posix.isAbsolute(program) && ['bash', 'sh', 'zsh', 'fish'].includes(posix.basename(program))) return posix.basename(program);
  return program;
}

function isWithinIfAbsolute(path: string, parent: string): boolean {
  return posix.isAbsolute(path) && isWithin(path, parent);
}

export function mapArgv(argv: readonly string[], mount: MountedWorkspace): string[] {
  if (!argv[0]) throw new Error('SSH subprocess argv must contain a program');
  const output = argv.map(argument => mapArgument(argument, mount));
  output[0] = mapExecutable(argv[0], mount);
  const shell = posix.basename(output[0]!);
  if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(shell)) {
    const commandOption = argv.findIndex((argument, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument));
    if (commandOption >= 0 && argv[commandOption + 1] !== undefined) {
      output[commandOption + 1] = mapShellCommand(argv[commandOption + 1]!, mount);
    }
  }
  return output;
}

function discoverPtcBootstraps(): readonly string[] {
  try {
    const entry = import.meta.resolve('@deepseek-ai/dsh-ptc-runtime-node/process');
    return [fileURLToPath(entry), fileURLToPath(new URL('./persistent-process.js', entry))];
  } catch { return []; }
}

const ptcBootstraps = discoverPtcBootstraps();

/** Only installed package-resolved worker paths are trusted; path-shaped lookalikes are not. */
export function isHostRuntime(
  argv: readonly string[], hostExecutables: readonly string[] = [], bootstraps: readonly string[] = ptcBootstraps,
): boolean {
  if (argv[0] !== undefined && hostExecutables.includes(argv[0])) return true;
  // Published DSH 0.2.1-rc.2: node --max-old-space-size=N <process.js> <maxMessageBytes>.
  return argv.length === 4 && /^--max-old-space-size=\d+$/.test(argv[1] ?? '')
    && bootstraps.includes(argv[2] ?? '') && /^\d+$/.test(argv[3] ?? '');
}

function mapEnvironment<T extends Record<string, string | undefined>>(environment: T | undefined, mount: MountedWorkspace): T | undefined {
  if (environment === undefined) return undefined;
  return Object.fromEntries(Object.entries(environment).map(([name, value]) => {
    if (value === undefined) return [name, undefined];
    return [name, name === 'PATH' ? value.split(':').map(part => mapPath(part, mount)).join(':') : mapPath(value, mount)];
  })) as T;
}

type RoutingContext = Pick<Context, 'effect'> & { subprocess: SubprocessRuntime; sandbox: SandboxProvider };

/**
 * Effect-scoped interception preserves the installed providers and their
 * original caller context. Do not remove registered mounts before teardown:
 * offline records are the fail-closed routing guard for their directories.
 */
export function installRouting(ctx: RoutingContext, manager: RoutingManager): () => void | Promise<void> {
  if (process.platform === 'win32') throw new Error('DSH SSH workspaces require a Linux/macOS host (use WSL2 on Windows).');
  const originalSymbol = Symbol.for('cordis.original');
  const raw = <T extends object>(value: T): T => Reflect.get(value, originalSymbol) as T | undefined ?? value;
  const subprocess = raw(ctx.subprocess);
  const sandbox = raw(ctx.sandbox);
  const spawn = subprocess.spawn;
  const spawnTerminal = subprocess.spawnTerminal;
  const confine = sandbox.confine;
  const descriptors = {
    spawn: Object.getOwnPropertyDescriptor(subprocess, 'spawn'),
    spawnTerminal: Object.getOwnPropertyDescriptor(subprocess, 'spawnTerminal'),
    confine: Object.getOwnPropertyDescriptor(sandbox, 'confine'),
  };
  const confinedRoutes = new WeakMap<readonly string[], { kind: 'host'; exceptionServer?: string } | { kind: 'remote'; mount: MountedWorkspace; provider: RemoteProviders }>();
  let active = true;
  function ready(mount: MountedWorkspace): RemoteProviders {
    const provider = manager.getRemote(mount.serverId);
    if (mount.status !== undefined && mount.status !== 'mounted' || provider === undefined) {
      throw new Error(`SSH workspace ${mount.localPath} is offline. Reconnect and mount server ${mount.serverId}; refusing local execution.`);
    }
    return provider;
  }
  function route(spec: { cwd: string; argv: readonly string[] }) {
    const marked = confinedRoutes.get(spec.argv);
    const mount = findMount(spec.cwd, manager.listMounts());
    if (marked?.kind === 'host') {
      if (mount !== undefined && marked.exceptionServer !== mount.serverId) throw new Error('A host sandbox cannot enforce a remote subprocess; refusing execution.');
      if (mount !== undefined) ready(mount);
      return undefined;
    }
    if (marked?.kind === 'remote') {
      if (mount === undefined || mount.serverId !== marked.mount.serverId) throw new Error('Remote sandbox and subprocess execution worlds differ; refusing execution.');
      if (ready(mount) !== marked.provider) throw new Error('SSH connection changed after confinement; retry the entire tool call.');
      return { mount, provider: marked.provider, argv: spec.argv };
    }
    if (mount === undefined) return undefined;
    const provider = ready(mount);
    if (isHostRuntime(spec.argv, mount.hostExecutables)) return undefined;
    return { mount, provider, argv: mapArgv(spec.argv, mount) };
  }
  const routedSpawn = function(this: SubprocessRuntime, spec: SubprocessSpawnSpec) {
    if (!active) return Reflect.apply(spawn, this, [spec]);
    const selected = route(spec);
    if (selected === undefined) return Reflect.apply(spawn, this, [spec]);
    const handle = selected.provider.subprocess.spawn({ ...spec, argv: selected.argv, cwd: mapPath(spec.cwd, selected.mount), env: mapEnvironment(spec.env, selected.mount) });
    // Keep stream/handle identity, but annotate missing remote executable errors.
    const done = handle.done.catch((error: unknown) => {
      throw new Error(`Remote execution on ${selected.mount.serverId} failed: ${error instanceof Error ? error.message : String(error)}. Host-installed binaries need installation on the remote or an explicit executableMap/hostExecutables entry.`, { cause: error });
    });
    void done.catch(() => {});
    return new Proxy(handle, { get(target, property) {
      if (property === 'done') return done;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const routedTerminal = async function(this: SubprocessRuntime, spec: SubprocessTerminalSpawnSpec) {
    if (!active) return Reflect.apply(spawnTerminal, this, [spec]);
    const selected = route(spec);
    if (selected === undefined) return Reflect.apply(spawnTerminal, this, [spec]);
    return selected.provider.subprocess.spawnTerminal({ ...spec, argv: selected.argv, cwd: mapPath(spec.cwd, selected.mount), env: mapEnvironment(spec.env, selected.mount) });
  };
  const routedConfine = async function(this: SandboxProvider, argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) {
    if (!active) return Reflect.apply(confine, this, [argv, policy, signal]);
    const mount = findMount(policy.workspaceRoot, manager.listMounts());
    if (mount === undefined) {
      const result = await Reflect.apply(confine, this, [argv, policy, signal]);
      confinedRoutes.set(result.argv, { kind: 'host' });
      return result;
    }
    const provider = ready(mount);
    if (isHostRuntime(argv, mount.hostExecutables)) {
      const result = await Reflect.apply(confine, this, [argv, policy, signal]);
      confinedRoutes.set(result.argv, { kind: 'host', exceptionServer: mount.serverId });
      return result;
    }
    const mapped = mapArgv(argv, mount);
    mapped[0] = await provider.subprocess.resolveExecutable(mapped[0]!, undefined, signal);
    const result = await provider.sandbox.confine(mapped, { ...policy, workspaceRoot: mapPath(policy.workspaceRoot, mount) }, signal);
    confinedRoutes.set(result.argv, { kind: 'remote', mount, provider });
    return result;
  };
  return ctx.effect(() => {
    subprocess.spawn = routedSpawn;
    subprocess.spawnTerminal = routedTerminal;
    sandbox.confine = routedConfine;
    return () => {
      active = false;
      const restore = (target: object, key: string, installed: unknown, descriptor: PropertyDescriptor | undefined) => {
        if (Reflect.get(target, key) !== installed) return;
        if (descriptor === undefined) Reflect.deleteProperty(target, key);
        else Object.defineProperty(target, key, descriptor);
      };
      restore(subprocess, 'spawn', routedSpawn, descriptors.spawn);
      restore(subprocess, 'spawnTerminal', routedTerminal, descriptors.spawnTerminal);
      restore(sandbox, 'confine', routedConfine, descriptors.confine);
    };
  }, 'ssh-workspaces.routing');
}
