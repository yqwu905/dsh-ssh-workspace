/** Same-origin, authenticated management API. It never accepts private keys or shell commands. */
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface ManagementApi {
    state(): unknown;
    configHosts(): Promise<unknown>;
    beginConnect(id: string): unknown;
    upsertServer(value: unknown): Promise<unknown>;
    removeServer(id: string): Promise<unknown>;
    connect(id: string): Promise<unknown>;
    disconnect(id: string): Promise<unknown>;
    probe(id: string): Promise<unknown>;
    addWorkspace(value: unknown): Promise<unknown>;
    mountWorkspace(id: string): Promise<unknown>;
    unmountWorkspace(id: string): Promise<unknown>;
    removeWorkspace(id: string): Promise<unknown>;
}
export type RequestFence = (request: IncomingMessage) => 401 | 403 | undefined;
export declare const API_PATH = "/api/ssh-workspaces";
/** Create the authenticated route handler; all writes are explicit Web actions. */
export declare function managementHandler(api: ManagementApi, fence: RequestFence): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
