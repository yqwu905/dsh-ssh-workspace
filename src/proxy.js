/**
 * A small HTTP proxy on the host's loopback. Each server reaches it through
 * an SSH reverse forward, so programs on servers without outbound access can
 * still use the network paths the host has (package registries, model APIs).
 * Supports CONNECT tunnels (HTTPS) and absolute-URI plain HTTP requests.
 * @module dsh-ssh-fleet/proxy
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect, isIP } from 'node:net'

/**
 * Whether an IP address is loopback, private, link-local, CGNAT or otherwise
 * not a public destination.
 * @param {string} address
 */
export function isPrivateAddress(address) {
  const v4 = address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const v6 = v4.toLowerCase()
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || /^fe[89ab]/.test(v6)
}

/**
 * Resolve a destination and enforce the private-address rule.
 * @param {string} hostname
 * @param {boolean} allowPrivate
 * @param {boolean} hasUpstream - an upstream proxy may resolve names we cannot.
 * @returns {Promise<string>} the address (or name) to connect to.
 */
async function vetDestination(hostname, allowPrivate, hasUpstream) {
  const name = hostname.replace(/^\[|\]$/g, '')
  let addresses
  try {
    addresses = isIP(name) !== 0 ? [name] : (await lookup(name, { all: true })).map(a => a.address)
  } catch (error) {
    if (hasUpstream) return name
    throw error
  }
  if (!allowPrivate && addresses.some(isPrivateAddress)) {
    throw Object.assign(new Error(`${hostname} resolves to a private or loopback address`), { status: 403 })
  }
  // Connect to the vetted address so a second lookup cannot change it.
  return hasUpstream ? name : addresses[0]
}

/**
 * @param {string} hostname
 * @param {string[]} allow - exact hosts, "*.suffix" wildcards, or "*".
 */
export function isAllowed(hostname, allow) {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return allow.some((pattern) => {
    const p = pattern.toLowerCase()
    if (p === '*') return true
    if (p.startsWith('*.')) return name === p.slice(2) || name.endsWith(p.slice(1))
    return name === p
  })
}

/**
 * Resolve the upstream proxy setting: '' = direct, 'env' = the host's
 * HTTPS_PROXY/HTTP_PROXY, otherwise an http:// proxy URL.
 * @param {string} setting
 * @returns {URL | undefined}
 */
export function upstreamOf(setting) {
  const value = setting === 'env'
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? ''
    : setting
  if (value === '') return undefined
  const url = new URL(value)
  if (url.protocol !== 'http:') throw new Error(`ssh-fleet proxy: unsupported upstream proxy protocol ${url.protocol}`)
  return url
}

/** @param {URL} upstream */
function upstreamAuth(upstream) {
  if (upstream.username === '') return {}
  const token = Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64')
  return { 'proxy-authorization': `Basic ${token}` }
}

/**
 * Open a TCP tunnel to host:port, directly or through an upstream CONNECT proxy.
 * @param {string} hostname
 * @param {number} port
 * @param {URL | undefined} upstream
 * @param {(error: Error | undefined, socket?: import('node:net').Socket) => void} done
 */
function openTunnel(hostname, port, upstream, done) {
  if (upstream === undefined) {
    const socket = connect(port, hostname, () => done(undefined, socket))
    socket.once('error', error => done(error))
    return socket
  }
  const socket = connect(Number(upstream.port || 80), upstream.hostname, () => {
    const auth = upstreamAuth(upstream)
    const headers = Object.entries({ host: `${hostname}:${port}`, ...auth }).map(([k, v]) => `${k}: ${v}\r\n`).join('')
    socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\n${headers}\r\n`)
    let buffered = Buffer.alloc(0)
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      const end = buffered.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const status = Number(buffered.subarray(0, end).toString('latin1').split(' ')[1])
      if (status !== 200) {
        socket.destroy()
        done(new Error(`upstream proxy refused CONNECT ${hostname}:${port} (${status})`))
        return
      }
      const rest = buffered.subarray(end + 4)
      if (rest.length > 0) socket.unshift(rest)
      done(undefined, socket)
    }
    socket.on('data', onData)
  })
  socket.once('error', error => done(error))
  return socket
}

/**
 * Start the proxy.
 * @param {{ allow: string[], upstream: string, allowPrivate: boolean, logger: any }} options
 * @returns {Promise<{ port: number, user: string, token: string, close: () => Promise<void> }>}
 */
export async function startProxy(options) {
  const { allow, logger } = options
  const upstream = upstreamOf(options.upstream)
  // Every client must present this credential: the forwarded port is
  // reachable by any local user on each server.
  const user = 'dsh-fleet'
  const token = randomBytes(18).toString('base64url')
  const expected = Buffer.from(`Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`)
  const authorized = (req) => {
    const header = Buffer.from(String(req.headers['proxy-authorization'] ?? ''))
    return header.length === expected.length && timingSafeEqual(header, expected)
  }
  const deny = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dsh-ssh-fleet"\r\n\r\n'
  const sockets = new Set()
  const server = createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="dsh-ssh-fleet"' }).end()
      return
    }
    let url
    try {
      url = new URL(req.url ?? '')
    } catch {
      res.writeHead(400).end('dsh-ssh-fleet proxy: absolute URL required\n')
      return
    }
    if (url.protocol !== 'http:' || !isAllowed(url.hostname, allow)) {
      res.writeHead(403).end(`dsh-ssh-fleet proxy: ${url.hostname} is not allowed\n`)
      return
    }
    let address
    try {
      address = await vetDestination(url.hostname, options.allowPrivate, upstream !== undefined)
    } catch (error) {
      res.writeHead(/** @type {any} */ (error).status ?? 502).end(`dsh-ssh-fleet proxy: ${/** @type {Error} */ (error).message}\n`)
      return
    }
    const headers = { ...req.headers }
    delete headers['proxy-authorization']
    const forward = httpRequest(upstream === undefined
      ? { host: address, servername: url.hostname, port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers }
      : { host: upstream.hostname, port: upstream.port || 80, method: req.method, path: url.href, headers: { ...headers, ...upstreamAuth(upstream) } },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    forward.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502)
      res.end(`dsh-ssh-fleet proxy: ${error.message}\n`)
    })
    req.pipe(forward)
  })
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {})
    if (!authorized(req)) {
      client.end(deny)
      return
    }
    const [hostname, portText] = splitHostPort(req.url ?? '')
    const port = Number(portText || 443)
    if (hostname === '' || !Number.isInteger(port) || !isAllowed(hostname, allow)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    let address
    try {
      address = await vetDestination(hostname, options.allowPrivate, upstream !== undefined)
    } catch (error) {
      client.end(`HTTP/1.1 ${/** @type {any} */ (error).status === 403 ? '403 Forbidden' : '502 Bad Gateway'}\r\n\r\n`)
      return
    }
    let settled = false
    const tunnel = openTunnel(address, port, upstream, (error, socket) => {
      if (settled) return
      settled = true
      if (error !== undefined || socket === undefined) {
        logger.debug?.(`[ssh-fleet] proxy ${hostname}:${port}: ${error?.message}`)
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        return
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) socket.write(head)
      socket.pipe(client)
      client.pipe(socket)
      socket.on('error', () => client.destroy())
    })
    sockets.add(tunnel)
    tunnel.on('close', () => sockets.delete(tunnel))
    client.on('error', () => tunnel.destroy())
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  logger.info(`[ssh-fleet] proxy listening on 127.0.0.1:${port}`)
  return {
    port,
    user,
    token,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** @param {string} value */
function splitHostPort(value) {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return [value.slice(1, end), value.slice(end + 2)]
  }
  const index = value.lastIndexOf(':')
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)]
}
