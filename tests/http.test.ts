import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { managementHandler, type ManagementApi } from '../src/http.ts';

test('API applies authentication and origin fence before mutations', async () => {
  let writes = 0;
  let reads = 0, connects = 0;
  const api = { state: () => ({ servers: [], workspaces: [] }), upsertServer: async () => { writes++; },
    configHosts: async () => { reads++; return { hosts: [{host:'gpu',source:'/fixture/.ssh/config'}], warnings: [] }; },
    beginConnect: () => { connects++; return { servers: [{id:'server',status:'connecting'}],workspaces:[] }; },
  } as unknown as ManagementApi;
  const server = createServer(managementHandler(api, req => req.headers.authorization === 'test' ? undefined : 403));
  server.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/ssh-workspaces`;
  try {
    assert.equal((await fetch(url + '/servers', { method: 'POST', body: '{}' })).status, 403);
    assert.equal(writes, 0);
    assert.equal((await fetch(url + '/ssh-config')).status, 403);
    assert.equal(reads, 0);
    assert.equal((await fetch(url + '/servers', { method: 'POST', headers: { authorization: 'test' }, body: '{}' })).status, 415);
    const headers = { authorization: 'test', 'content-type': 'application/json' };
    assert.equal((await fetch(url + '/servers', { method: 'POST', headers, body: '{bad' })).status, 400);
    assert.equal((await fetch(url + '/servers', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(writes, 1);
    assert.equal((await fetch(url + '/servers', { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(66000) }) })).status, 413);
    assert.equal(writes, 1);
    assert.equal((await fetch(url, { headers })).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url + '-other', { headers })).status, 404);
    const discovery = await fetch(url + '/ssh-config', { headers });
    assert.equal((await discovery.json()).hosts[0].host, 'gpu');
    assert.equal(reads, 1);
    const connect = await fetch(url + '/servers/server/connect', { method: 'POST', headers });
    assert.equal(connect.status, 202);
    assert.equal((await connect.json()).servers[0].status, 'connecting');
    assert.equal(connects, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
