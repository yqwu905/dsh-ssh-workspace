/**
 * Plugin configuration.
 * @module dsh-ssh-fleet/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

const SANDBOX = z.union(['auto', 'bwrap', 'unconfined', 'refuse'])

export const HostConfig = z.object({
  id: z.string().required().description('Name used by /ssh, anchors and logs.'),
  host: z.string().required().description('OpenSSH destination: an ~/.ssh/config alias or a hostname.'),
  user: z.string(),
  port: z.natural(),
  identityFile: z.string(),
  sshOptions: z.array(z.string()).default([]).description('Extra ssh -o options, e.g. "ProxyJump=bastion".'),
  workspace: z.string().description('Default remote working directory (absolute or ~/...). Defaults to the remote home.'),
  description: z.string(),
  sandbox: SANDBOX.description('Overrides the global remote sandbox setting.'),
  proxy: z.boolean().description('Overrides proxy.enabled for this server.'),
})

/**
 * @typedef {object} FleetConfig
 * @property {import('./ssh.js').HostConfig[]} hosts
 * @property {string} hostsFile
 * @property {string} anchorsDir
 * @property {string} dshHome
 * @property {string} agentsHome
 * @property {boolean} mirrorSkills
 * @property {string[]} mirrors
 * @property {number} mirrorCheckIntervalMs
 * @property {'auto'|'bwrap'|'unconfined'|'refuse'} sandbox
 * @property {{ enabled: boolean, allow: string[], allowPrivate: boolean, upstream: string }} proxy
 * @property {boolean} uploadRipgrep
 * @property {number} connectTimeoutSec
 * @property {number} helperWorkers
 * @property {string} [controlDir]
 * @property {string[]} hostPaths
 * @property {number} diffBasisMaxBytes
 */

const dshHome = () => resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const agentsHome = () => resolve(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'))

export const Config = z.object({
  hosts: z.array(HostConfig).default([]).description('Servers. Merged with hostsFile.'),
  hostsFile: z.string().default(join(dshHome(), 'ssh-fleet', 'hosts.json')).description('JSON file with an array of hosts or { "hosts": [...] }. Empty string disables it.'),
  anchorsDir: z.string().default(join(dshHome(), 'ssh-fleet', 'anchors')).description('Sessions created in <anchorsDir>/<hostId> are bound to that server. Empty string disables anchors.'),
  dshHome: z.string().default(dshHome()),
  agentsHome: z.string().default(agentsHome()),
  mirrorSkills: z.boolean().default(true).description('Mirror <dshHome>/skills and <agentsHome>/skills to every server.'),
  mirrors: z.array(z.string()).default([]).description('More host directories to mirror (e.g. custom skill roots).'),
  mirrorCheckIntervalMs: z.natural().default(3000),
  sandbox: SANDBOX.default('auto').description('Remote command confinement: auto/bwrap = bubblewrap when present, otherwise refuse confined modes.'),
  proxy: z.object({
    enabled: z.boolean().default(false).description('Expose a host-side HTTP proxy to servers through SSH reverse forwarding.'),
    allow: z.array(z.string()).default([]).description('Destination hosts the proxy accepts: exact names, "*.suffix" or "*". Empty = nothing.'),
    allowPrivate: z.boolean().default(false).description('Also allow destinations that resolve to loopback/private/link-local addresses (reachable from the host).'),
    upstream: z.string().default('').description('Upstream HTTP proxy for the host side: "" = direct, "env" = the host\'s HTTPS_PROXY/HTTP_PROXY, or an http:// URL.'),
  }).default({}),
  uploadRipgrep: z.boolean().default(true).description('Upload the host ripgrep binary to servers that lack rg (same OS/arch only).'),
  connectTimeoutSec: z.natural().default(15),
  helperWorkers: z.natural().default(2).description('Long-lived helper processes per server for file operations, so the login shell (~/.bashrc) starts once instead of per operation. 0 = one ssh command per operation.'),
  controlDir: z.string().description('Directory for ssh ControlMaster sockets. Defaults to <tmpdir>/dsh-ssh-fleet-<uid>.'),
  hostPaths: z.array(z.string()).default([]).description('Extra host path prefixes that stay on the host in remote sessions.'),
  diffBasisMaxBytes: z.natural().default(4 * 1024 * 1024),
})
