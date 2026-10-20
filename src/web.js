/**
 * Web API for the browser half: server management (including import from
 * ~/.ssh/config), connection tests, remote directory browsing and remote
 * workspace creation. Every route is an exact Fetch route of the client
 * connection, so it inherits the Web carrier's Host/Origin fence and browser
 * authentication; only owner Peers reach it.
 * @module dsh-ssh-fleet/web
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { readHostsFile } from './fleet.js'
import { SshHost } from './ssh.js'

const PREFIX = '/api/ssh-fleet.'
const MAX_ENTRIES = 1000
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SANDBOX_VALUES = new Set(['auto', 'bwrap', 'unconfined', 'refuse'])

class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - context holding `connection`.
 * @param {import('./fleet.js').Fleet} fleet
 */
export function registerWebApi(ctx, fleet) {
  const routes = {
    'hosts': ['GET', () => listHosts(fleet)],
    'hosts.save': ['POST', body => saveHost(fleet, body)],
    'hosts.remove': ['POST', body => removeHost(fleet, body)],
    'hosts.test': ['POST', body => testHost(fleet, body)],
    'ssh-config': ['GET', (_body, url) => sshConfigCandidates(fleet, url.searchParams.get('path') ?? undefined)],
    'ssh-config.import': ['POST', body => importSshConfig(fleet, body)],
    'dir': ['GET', (_body, url) => listRemoteDirectory(fleet, url.searchParams.get('host') ?? '', url.searchParams.get('path') ?? undefined)],
    'mkdir': ['POST', body => makeRemoteDirectory(fleet, body)],
    'workspace': ['POST', body => createRemoteWorkspace(ctx, fleet, body)],
  }
  for (const [name, [method, handler]] of Object.entries(routes)) {
    ctx.connection.fetch.register({
      path: `${PREFIX}${name}`,
      methods: [method],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = method === 'POST' ? await request.json().catch(() => { throw new ApiError(400, 'invalid JSON body') }) : undefined
          const result = await handler(body, new URL(request.url))
          return Response.json(result, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          const status = error instanceof ApiError ? error.status : 500
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status, headers: { 'cache-control': 'no-store' } })
        }
      },
    })
  }
}

// --- Hosts ------------------------------------------------------------------

/** @param {import('./fleet.js').Fleet} fleet */
function listHosts(fleet) {
  const inline = new Set((fleet.config.inlineHosts ?? []).map(h => h.id))
  return {
    hostsFile: fleet.config.hostsFile,
    anchorsDir: fleet.config.anchorsDir,
    hosts: [...fleet.hosts.values()].map(entry => ({
      ...entry.config,
      source: inline.has(entry.id) ? 'config' : 'file',
      state: entry.info !== undefined
        ? { status: 'connected', os: entry.info.os, arch: entry.info.arch, home: entry.info.home }
        : entry.lastError !== undefined ? { status: 'error', error: entry.lastError } : { status: 'idle' },
    })),
  }
}

/**
 * Validate and normalize one host record from the browser.
 * @param {any} input
 * @returns {import('./ssh.js').HostConfig}
 */
export function normalizeHost(input) {
  if (typeof input !== 'object' || input === null) throw new ApiError(400, 'host must be an object')
  const text = (key) => {
    const value = input[key]
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new ApiError(400, `${key} must be a string`)
    return value.trim() === '' ? undefined : value.trim()
  }
  const id = text('id')
  const host = text('host')
  if (id === undefined || !ID_PATTERN.test(id)) throw new ApiError(400, 'id must start with a letter or digit and contain only letters, digits, ".", "_" or "-"')
  if (host === undefined || /\s/.test(host) || host.startsWith('-')) throw new ApiError(400, 'host must be an ssh destination without spaces')
  const user = text('user')
  if (user !== undefined && (/\s/.test(user) || user.startsWith('-'))) throw new ApiError(400, 'user is invalid')
  let port
  if (input.port !== undefined && input.port !== null && input.port !== '') {
    port = Number(input.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'port must be 1-65535')
  }
  const sshOptions = Array.isArray(input.sshOptions) ? input.sshOptions : typeof input.sshOptions === 'string' ? input.sshOptions.split('\n') : []
  const options = sshOptions.map(o => String(o).trim()).filter(Boolean)
  for (const option of options) {
    if (!/^[A-Za-z][A-Za-z0-9]*[ =]\S/.test(option)) throw new ApiError(400, `ssh option "${option}" must look like Key=Value`)
  }
  const sandbox = text('sandbox')
  if (sandbox !== undefined && !SANDBOX_VALUES.has(sandbox)) throw new ApiError(400, 'sandbox must be auto, bwrap, unconfined or refuse')
  const workspace = text('workspace')
  if (workspace !== undefined && !workspace.startsWith('/') && workspace !== '~' && !workspace.startsWith('~/')) {
    throw new ApiError(400, 'workspace must be an absolute path or start with ~/')
  }
  /** @type {import('./ssh.js').HostConfig} */
  const result = { id, host }
  if (user !== undefined) result.user = user
  if (port !== undefined) result.port = port
  const identityFile = text('identityFile')
  if (identityFile !== undefined) result.identityFile = identityFile
  if (options.length > 0) result.sshOptions = options
  if (workspace !== undefined) result.workspace = workspace
  const description = text('description')
  if (description !== undefined) result.description = description
  if (sandbox !== undefined && sandbox !== 'auto') result.sandbox = sandbox
  if (typeof input.proxy === 'boolean') result.proxy = input.proxy
  return result
}

/**
 * Read-modify-write the hosts file atomically.
 * @param {string} path
 * @param {(hosts: any[]) => any[]} change
 */
async function updateHostsFile(path, change) {
  if (path === '') throw new ApiError(409, 'the hosts file is disabled (hostsFile is empty); configure servers in cordis.patch.yml')
  let document = { hosts: [] }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    document = Array.isArray(parsed) ? { hosts: parsed } : parsed
  } catch (error) {
    if (/** @type {any} */ (error).code !== 'ENOENT') throw error
  }
  document.hosts = change(Array.isArray(document.hosts) ? document.hosts : [])
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} body - { host, create }
 */
async function saveHost(fleet, body) {
  const host = normalizeHost(body?.host)
  if ((fleet.config.inlineHosts ?? []).some(h => h.id === host.id)) {
    throw new ApiError(409, `${host.id} is defined in cordis.patch.yml and cannot be edited here`)
  }
  await updateHostsFile(fleet.config.hostsFile, (hosts) => {
    const index = hosts.findIndex(h => h?.id === host.id)
    if (body?.create === true && index >= 0) throw new ApiError(409, `a server named ${host.id} already exists`)
    if (index >= 0) hosts[index] = host
    else hosts.push(host)
    return hosts
  })
  await fleet.reloadHosts()
  return { host }
}

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} body - { id }
 */
async function removeHost(fleet, body) {
  const id = String(body?.id ?? '')
  if ((fleet.config.inlineHosts ?? []).some(h => h.id === id)) {
    throw new ApiError(409, `${id} is defined in cordis.patch.yml and cannot be removed here`)
  }
  let found = false
  await updateHostsFile(fleet.config.hostsFile, hosts => hosts.filter((h) => {
    if (h?.id !== id) return true
    found = true
    return false
  }))
  if (!found) throw new ApiError(404, `no server named ${id}`)
  await fleet.reloadHosts()
  return { removed: id }
}

/**
 * Connect once with an unsaved configuration, isolated from live masters.
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} body - { host }
 */
async function testHost(fleet, body) {
  const config = normalizeHost(body?.host)
  const controlDir = mkdtempSync('/tmp/dsh-sft-')
  const ssh = new SshHost(config, { controlDir, connectTimeoutSec: fleet.config.connectTimeoutSec, logger: fleet.logger })
  const started = Date.now()
  try {
    const info = await ssh.ready()
    return {
      ok: true,
      latencyMs: Date.now() - started,
      os: info.os,
      arch: info.arch,
      home: info.home,
      shell: info.shell,
      bwrap: info.commands.bwrap !== undefined,
      rg: info.commands.rg !== undefined,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await ssh.close()
    rmSync(controlDir, { recursive: true, force: true })
  }
}

// --- ~/.ssh/config import ---------------------------------------------------------

/**
 * Concrete Host aliases declared in an ssh config file and its Includes.
 * @param {string} path
 * @param {Set<string>} [seen]
 * @returns {Promise<string[]>}
 */
export async function sshConfigAliases(path, seen = new Set()) {
  if (seen.has(path) || seen.size > 32) return []
  seen.add(path)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return []
  }
  const aliases = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim()
    const match = /^(\S+)\s*(?:=\s*|\s+)(.+)$/.exec(line)
    if (match === null) continue
    const keyword = match[1].toLowerCase()
    const value = match[2].trim()
    if (keyword === 'host') {
      for (const pattern of value.split(/\s+/)) {
        const name = pattern.replace(/^"|"$/g, '')
        if (name !== '' && !/[*?!]/.test(name) && !aliases.includes(name)) aliases.push(name)
      }
    } else if (keyword === 'include') {
      for (const item of value.split(/\s+/)) {
        const expanded = item.replace(/^~(?=\/)/, homedir())
        const target = isAbsolute(expanded) ? expanded : join(homedir(), '.ssh', expanded)
        for (const file of await expandGlob(target)) {
          for (const alias of await sshConfigAliases(file, seen)) if (!aliases.includes(alias)) aliases.push(alias)
        }
      }
    }
  }
  return aliases
}

/** Minimal glob for Include patterns ("*" and "?" in the last segment). @param {string} pattern */
async function expandGlob(pattern) {
  if (!/[*?]/.test(pattern)) return [pattern]
  const directory = dirname(pattern)
  const regex = new RegExp(`^${posix.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  const { readdir } = await import('node:fs/promises')
  try {
    return (await readdir(directory)).filter(name => regex.test(name)).sort().map(name => join(directory, name))
  } catch {
    return []
  }
}

/**
 * Effective settings of one alias as OpenSSH computes them.
 * @param {string} alias
 * @param {string | undefined} configPath
 */
function sshEffective(alias, configPath) {
  return new Promise((resolveResult) => {
    const args = [...configPath === undefined ? [] : ['-F', configPath], '-G', '--', alias]
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolveResult(undefined))
    child.on('close', (code) => {
      if (code !== 0) return resolveResult(undefined)
      /** @type {Record<string, string>} */
      const values = {}
      for (const line of out.split('\n')) {
        const space = line.indexOf(' ')
        if (space > 0 && values[line.slice(0, space)] === undefined) values[line.slice(0, space)] = line.slice(space + 1)
      }
      resolveResult(values)
    })
  })
}

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {string | undefined} path
 */
async function sshConfigCandidates(fleet, path) {
  const configPath = path === undefined || path === '' ? join(homedir(), '.ssh', 'config') : resolve(path.replace(/^~(?=\/)/, homedir()))
  const custom = path !== undefined && path !== '' ? configPath : undefined
  const aliases = await sshConfigAliases(configPath)
  const configured = new Map([...fleet.hosts.values()].map(entry => [entry.config.host, entry.id]))
  const candidates = await Promise.all(aliases.map(async (alias) => {
    const values = await sshEffective(alias, custom)
    return {
      alias,
      id: alias.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'server',
      hostname: values?.hostname,
      user: values?.user,
      port: values?.port === undefined ? undefined : Number(values.port),
      proxyJump: values?.proxyjump === 'none' ? undefined : values?.proxyjump,
      identityFile: values?.identityfile?.split(' ')[0],
      configuredAs: configured.get(alias),
    }
  }))
  return { path: configPath, candidates }
}

/**
 * Register aliases as servers. From the default ~/.ssh/config the alias
 * itself is the destination, so ssh keeps applying every setting there;
 * aliases from another file are imported with their effective settings.
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} body - { aliases: string[], configPath? }
 */
async function importSshConfig(fleet, body) {
  const aliases = Array.isArray(body?.aliases) ? body.aliases.map(String) : []
  if (aliases.length === 0) throw new ApiError(400, 'choose at least one host to import')
  const listing = await sshConfigCandidates(fleet, typeof body?.configPath === 'string' ? body.configPath : undefined)
  const isDefault = listing.path === join(homedir(), '.ssh', 'config')
  const outcomes = []
  await updateHostsFile(fleet.config.hostsFile, (hosts) => {
    const taken = new Set([...hosts.map(h => h?.id), ...(fleet.config.inlineHosts ?? []).map(h => h.id)])
    for (const alias of aliases) {
      const candidate = listing.candidates.find(c => c.alias === alias)
      if (candidate === undefined) {
        outcomes.push({ alias, skipped: 'not found in the config file' })
        continue
      }
      if (hosts.some(h => h?.host === alias)) {
        outcomes.push({ alias, skipped: 'already configured' })
        continue
      }
      let id = candidate.id
      for (let n = 2; taken.has(id); n++) id = `${candidate.id}-${n}`
      taken.add(id)
      const host = isDefault
        ? normalizeHost({ id, host: alias })
        : normalizeHost({
            id,
            host: candidate.hostname ?? alias,
            user: candidate.user,
            port: candidate.port,
            identityFile: candidate.identityFile,
            sshOptions: candidate.proxyJump === undefined ? [] : [`ProxyJump=${candidate.proxyJump}`],
          })
      hosts.push(host)
      outcomes.push({ alias, id })
    }
    return hosts
  })
  await fleet.reloadHosts()
  return { outcomes }
}

// --- Remote directories --------------------------------------------------------------

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {string} hostId
 */
function entryOf(fleet, hostId) {
  const entry = fleet.hosts.get(hostId)
  if (entry === undefined) throw new ApiError(404, `no server named ${hostId}`)
  return entry
}

/** Breadcrumbs from "/" to `path`. @param {string} path */
function crumbsOf(path) {
  const crumbs = [{ name: '/', path: '/', hidden: false }]
  let current = ''
  for (const segment of path.split('/').filter(Boolean)) {
    current = `${current}/${segment}`
    crumbs.push({ name: segment, path: current, hidden: false })
  }
  return crumbs
}

/**
 * One remote directory level in the shape of the Host browse picker's
 * `DirectoryListing`: child directories only, hidden rows flagged.
 * @param {import('./fleet.js').Fleet} fleet
 * @param {string} hostId
 * @param {string | undefined} path
 */
async function listRemoteDirectory(fleet, hostId, path) {
  const entry = entryOf(fleet, hostId)
  const info = await entry.ready().catch((error) => { throw new ApiError(502, error instanceof Error ? error.message : String(error)) })
  if (path !== undefined && !path.startsWith('/') && path !== '~' && !path.startsWith('~/')) throw new ApiError(400, `cannot list "${path}": not an absolute path`)
  const requested = fleet.expandRemote(path ?? '~', info.home)
  const target = await entry.fs.resolve(requested)
  let children
  try {
    children = await entry.fs.listDir(target)
  } catch (error) {
    throw new ApiError(400, `cannot list ${target.displayPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const directories = children.filter(child => child.type === 'directory')
  const entries = directories.slice(0, MAX_ENTRIES).map(child => ({
    name: child.name,
    path: posix.join(target.displayPath, child.name),
    hidden: child.name.startsWith('.'),
  }))
  return { path: target.displayPath, home: info.home, crumbs: crumbsOf(target.displayPath), entries, truncated: directories.length > MAX_ENTRIES }
}

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} body - { host, path, name }
 */
async function makeRemoteDirectory(fleet, body) {
  const entry = entryOf(fleet, String(body?.host ?? ''))
  const parent = String(body?.path ?? '')
  const name = String(body?.name ?? '').trim()
  if (!parent.startsWith('/')) throw new ApiError(400, 'parent must be an absolute path')
  if (name === '' || name === '.' || name === '..' || name.includes('/')) throw new ApiError(400, 'invalid folder name')
  await entry.ready()
  const result = await entry.ssh.helper('mkdir', [parent, name])
  if (result.code === 16) throw new ApiError(409, `${name} already exists`)
  if (result.code !== 0) throw new ApiError(400, `cannot create ${name} in ${parent}${result.code === 13 ? ': permission denied' : ''}`)
  return { path: result.stdout.toString('utf8').trim() }
}

/**
 * Register a remote directory as a Workspace: its host-side placeholder is
 * an anchor path, titled "<server>:<path>".
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} body - { host, path }
 */
async function createRemoteWorkspace(ctx, fleet, body) {
  const hostId = String(body?.host ?? '')
  const entry = entryOf(fleet, hostId)
  const requested = String(body?.path ?? '')
  if (!requested.startsWith('/')) throw new ApiError(400, 'path must be absolute')
  await entry.ready()
  const target = await entry.fs.resolve(requested)
  const stat = await entry.fs.stat(target)
  if (stat?.type !== 'directory') throw new ApiError(400, `${hostId}:${target.displayPath} is not a directory`)
  if (target.displayPath === '/') throw new ApiError(400, 'choose a directory below /')
  const localPath = fleet.anchorPathFor(hostId, target.displayPath)
  mkdirSync(localPath, { recursive: true })
  const title = `${hostId}:${target.displayPath}`
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    const workspace = await registry.create(localPath, title)
    if (typeof workspace?.setTitle === 'function' && workspace.title !== title) await workspace.setTitle(title).catch(() => {})
  }
  return { path: localPath, title, remotePath: target.displayPath }
}

export { readHostsFile }
