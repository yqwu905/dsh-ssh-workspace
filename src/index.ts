/** DSH 0.2.1-rc.2 host plugin: authenticated Web management and per-workspace routing. */
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-workspace';
import schema from '@deepseek-ai/schemastery';
import { SshWorkspaceManager } from './manager.js';
import { installRouting } from './routing.js';
import { installFsRouting } from './fs-routing.js';
import { API_PATH, managementHandler } from './http.js';

export const name = 'ssh-workspaces';
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'subprocess', 'sandbox', 'sandboxPolicy', 'fs'];
export interface Config {
  stateDir: string;
  mountRoot: string;
  requestTimeoutMs: number;
  mountTimeoutMs: number;
  sshfsBinary: string;
  helperInstallTimeoutMs: number;
}
export const Config: schema<Config> = schema.object({
  stateDir: schema.string().default(join(homedir(), '.dsh', 'ssh-workspaces')),
  mountRoot: schema.string().default(join(homedir(), '.dsh', 'ssh-workspaces', 'mounts')),
  requestTimeoutMs: schema.number().min(1000).max(600000).step(1).default(30000),
  mountTimeoutMs: schema.number().min(1000).max(120000).step(1).default(20000),
  sshfsBinary: schema.string().default('sshfs'),
  helperInstallTimeoutMs: schema.number().min(30000).max(3600000).step(1).default(600000),
});

interface ConnectionFence {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined;
}

/** Install without changing the user's profiles, plugin catalog, model settings or credentials. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.stateDir) || !isAbsolute(config.mountRoot)) throw new Error('SSH stateDir and mountRoot must be absolute paths.');
  const connection = Reflect.get(ctx, 'connection') as ConnectionFence;
  if (typeof connection?.requestRejection !== 'function') throw new Error('Unsupported DSH connection API: requestRejection is required.');
  const manager = new SshWorkspaceManager(ctx, config);
  ctx.effect(() => () => manager.dispose());
  await manager.ready;
  installRouting(ctx, manager);
  installFsRouting(ctx, manager);
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: API_PATH,
    handler: managementHandler(manager, request => connection.requestRejection(request)),
  }));
}
