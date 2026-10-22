import type { Context } from '@deepseek-ai/cordis';
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh';
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh';
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh';
import { type ServerRecord, type WorkspaceRecord } from './config.js';
import type { SetupPhase } from './helper-bundle.js';
import { type SandboxChecks } from './sandbox-diagnostics.js';
export type ServerStatus = 'disconnected' | 'connecting' | 'installing' | 'connected' | 'error';
export type MountStatus = 'unmounted' | 'mounting' | 'mounted' | 'error';
export type ServerView = ServerRecord & {
    status: ServerStatus;
    error?: string;
    setupPhase?: SetupPhase;
    sandboxChecks?: SandboxChecks;
};
export type WorkspaceView = WorkspaceRecord & {
    status: MountStatus;
    error?: string;
};
export interface ManagerState {
    servers: ServerView[];
    workspaces: WorkspaceView[];
}
export interface ManagerOptions {
    stateDir: string;
    mountRoot: string;
    requestTimeoutMs?: number;
    mountTimeoutMs?: number;
    sshfsBinary?: string;
    helperInstallTimeoutMs?: number;
}
export interface RemoteProviders {
    subprocess: SshSubprocessRuntime;
    sandbox: SshSandboxProvider;
    fs: SshFileSystem;
}
/** Parse Linux's escaped mountinfo fields without shell parsing. */
export declare function decodeMountPath(value: string): string;
/** Match exact mountpoint records, never directory contents or device names. */
export declare function mountinfoContains(contents: string, mountPath: string): boolean;
/** Manages registered mounts; unmounted records remain available to routing's fail-closed check. */
export declare class SshWorkspaceManager {
    private readonly ctx;
    readonly ready: Promise<void>;
    private readonly options;
    private readonly servers;
    private readonly workspaces;
    private readonly retiredMounts;
    private readonly remotes;
    private readonly mounts;
    private readonly connectJobs;
    private tail;
    private disposed;
    constructor(ctx: Context, options: ManagerOptions);
    /** Browser projection; errors never include credential file contents. */
    state(): ManagerState;
    configHosts(): Promise<import("./ssh-config.js").ConfigHosts>;
    /** Start a durable-in-process operation; a browser refresh must not cancel deployment. */
    beginConnect(id: string): ManagerState;
    /** Includes offline records so a stale conversation can never fall through to local execution. */
    listMounts(): Array<{
        serverId: string;
        host?: string;
        localPath: string;
        remotePath: string;
        executableMap: Record<string, string>;
        hostExecutables: string[];
        status: MountStatus;
    }>;
    /** Returns a provider only after the helper and all requested tunnels are ready. */
    getRemote(serverId: string): RemoteProviders | undefined;
    upsertServer(input: unknown): Promise<ManagerState>;
    removeServer(id: string): Promise<ManagerState>;
    connect(id: string): Promise<ManagerState>;
    disconnect(id: string): Promise<ManagerState>;
    addWorkspace(input: unknown): Promise<ManagerState>;
    mountWorkspace(id: string): Promise<ManagerState>;
    unmountWorkspace(id: string): Promise<ManagerState>;
    removeWorkspace(id: string): Promise<ManagerState>;
    probe(id: string): Promise<{
        ok: boolean;
        message: string;
        sandboxChecks: SandboxChecks;
    }>;
    private checkSandboxes;
    /** Teardown does not replay any interrupted operation. Sessions remain durable in DSH. */
    dispose(): Promise<void>;
    private initialize;
    private enqueue;
    private save;
    private requireServer;
    private requireWorkspace;
    private hasMounted;
    private connectInternal;
    private disconnectInternal;
    private assertRuntimeOutside;
    private assertInactive;
    private mountInternal;
    private unmountInternal;
    private unmountPhysical;
    private isMounted;
    private offlineMarker;
    private removeOfflineMarker;
    private startTunnels;
    private stopChild;
}
