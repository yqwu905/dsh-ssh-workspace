import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import type { RemoteProviders, RoutingManager } from './routing.js';
export interface FsRemoteProviders extends RemoteProviders {
    readonly fs: FileSystem;
}
export interface FsRoutingManager extends RoutingManager {
    getRemote(serverId: string): FsRemoteProviders | undefined;
}
type FsRoutingContext = Pick<Context, 'effect'> & {
    fs: FileSystem;
    sandboxPolicy: Pick<SandboxPolicyService, 'resolve'>;
};
/**
 * File tools use one native RPC path, preserving atomic version-guarded writes.
 * SSHFS remains the interoperability path for WorkspaceRegistry and trusted
 * plugins that call node:fs directly. Such direct calls do not use this fence.
 */
export declare function installFsRouting(ctx: FsRoutingContext, manager: FsRoutingManager): () => void | Promise<void>;
export {};
