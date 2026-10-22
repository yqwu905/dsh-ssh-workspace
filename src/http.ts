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
export const API_PATH = '/api/ssh-workspaces';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function json(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Use application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > 64 * 1024) {
      req.resume();
      throw new HttpError(413, 'Management request exceeds 64 KiB.');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

/** Create the authenticated route handler; all writes are explicit Web actions. */
export function managementHandler(api: ManagementApi, fence: RequestFence) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rejected = fence(req);
    if (rejected !== undefined) { send(res, rejected, { error: 'DSH authentication or origin check failed.' }); return; }
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path !== API_PATH && !path.startsWith(API_PATH + '/')) throw new HttpError(404, 'Unknown route.');
      const route = path.slice(API_PATH.length).split('/').filter(Boolean);
      if (req.method === 'GET' && route.length === 1 && route[0] === 'ssh-config') {
        send(res, 200, await api.configHosts()); return;
      }
      if (req.method === 'GET' && (route.length === 0 || (route.length === 1 && route[0] === 'state'))) {
        send(res, 200, api.state()); return;
      }
      if (req.method !== 'POST' && req.method !== 'DELETE') throw new HttpError(405, 'Use GET, POST or DELETE.');
      // No credentials, request URL or stderr is logged here.
      if (route.length === 1 && req.method === 'POST') {
        const body = await json(req);
        if (route[0] === 'servers') await api.upsertServer(body);
        else if (route[0] === 'workspaces') await api.addWorkspace(body);
        else throw new HttpError(404, 'Unknown resource.');
      } else {
        const [resource, id, action] = route;
        if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || route.length > 3) throw new HttpError(400, 'Invalid resource ID.');
        if (req.method === 'DELETE' && route.length === 2) {
          if (resource === 'servers') await api.removeServer(id);
          else if (resource === 'workspaces') await api.removeWorkspace(id);
          else throw new HttpError(404, 'Unknown resource.');
        } else if (req.method === 'POST' && route.length === 3) {
          if (resource === 'servers' && action === 'connect') { send(res, 202, api.beginConnect(id)); return; }
          else if (resource === 'servers' && action === 'disconnect') await api.disconnect(id);
          else if (resource === 'servers' && action === 'probe') {
            const result = await api.probe(id); send(res, 200, result); return;
          } else if (resource === 'workspaces' && action === 'mount') await api.mountWorkspace(id);
          else if (resource === 'workspaces' && action === 'unmount') await api.unmountWorkspace(id);
          else throw new HttpError(404, 'Unknown action.');
        } else throw new HttpError(404, 'Unknown action.');
      }
      send(res, 200, api.state());
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof Error && error.name === 'ZodError' ? 400 : 409;
      send(res, status, { error: error instanceof Error ? error.message : 'Operation failed.' });
    }
  };
}
