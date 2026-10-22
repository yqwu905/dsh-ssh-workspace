import type { Context } from '@deepseek-ai/cordis';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SandboxProvider } from '@deepseek-ai/dsh-sandbox';
export interface MountedWorkspace {
    readonly serverId: string;
    readonly host?: string;
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
export declare function isWithin(path: string, parent: string): boolean;
/** Longest enclosing mount wins; sibling names and lexical '..' never collide. */
export declare function findMount(path: string, mounts: readonly MountedWorkspace[]): MountedWorkspace | undefined;
export declare function mapPath(path: string, mount: MountedWorkspace): string;
/**
 * Translate literal mount prefixes in ordinary POSIX shell source. This is
 * deliberately not a shell rewriter: heredocs, substitutions and escaped mount
 * spellings require relative paths or the remote path supplied by the panel.
 * Rejecting those cases avoids changing the meaning of nested code/quoting.
 */
export declare function mapShellCommand(command: string, mount: MountedWorkspace): string;
/** Translate path operands, retaining unrelated literal data and sibling paths. */
export declare function mapArgument(argument: string, mount: MountedWorkspace): string;
/** No basename fallback for arbitrary host-installed binaries. Missing remote files fail loudly. */
export declare function mapExecutable(program: string, mount: MountedWorkspace): string;
export declare function mapArgv(argv: readonly string[], mount: MountedWorkspace): string[];
/** Only installed package-resolved worker paths are trusted; path-shaped lookalikes are not. */
export declare function isHostRuntime(argv: readonly string[], hostExecutables?: readonly string[], bootstraps?: readonly string[]): boolean;
type RoutingContext = Pick<Context, 'effect'> & {
    subprocess: SubprocessRuntime;
    sandbox: SandboxProvider;
};
/**
 * Effect-scoped interception preserves the installed providers and their
 * original caller context. Do not remove registered mounts before teardown:
 * offline records are the fail-closed routing guard for their directories.
 */
export declare function installRouting(ctx: RoutingContext, manager: RoutingManager): () => void | Promise<void>;
export {};
