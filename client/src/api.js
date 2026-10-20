/**
 * Browser access to the Host routes registered by src/web.js. The routes sit
 * inside the client connection's authentication fence, so a same-origin
 * fetch with the page's cookie is the whole transport. Paths are relative to
 * the page so a mounted deployment keeps working.
 */

const PREFIX = 'api/ssh-fleet.'

async function call(action, options = {}) {
  const { body, query, signal } = options
  const search = query === undefined ? '' : `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''))}`
  const response = await fetch(`${PREFIX}${action}${search}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    signal,
    ...body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : `request failed (${response.status})`)
  return payload
}

export const fleetApi = {
  hosts: () => call('hosts'),
  save: (host, create) => call('hosts.save', { body: { host, create } }),
  remove: id => call('hosts.remove', { body: { id } }),
  test: host => call('hosts.test', { body: { host } }),
  sshConfig: path => call('ssh-config', { query: { path } }),
  importSshConfig: (aliases, configPath) => call('ssh-config.import', { body: { aliases, configPath } }),
  listDirectory: (host, path, signal) => call('dir', { query: { host, path }, signal }),
  createDirectory: (host, path, name) => call('mkdir', { body: { host, path, name } }).then(r => r.path),
  createWorkspace: (host, path) => call('workspace', { body: { host, path } }),
}
