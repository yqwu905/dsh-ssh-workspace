/**
 * The `/ssh` command: list servers, bind the current Session to one, return
 * it to the local machine, or check connectivity.
 * @module dsh-ssh-fleet/commands
 */

import { homedir } from 'node:os'

const USAGE = 'Usage: /ssh [list] | /ssh <host> [remote-dir] | /ssh local | /ssh check [host] | /ssh reload'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./fleet.js').Fleet} fleet
 */
export function registerCommands(ctx, fleet) {
  ctx.commands.register({
    name: 'ssh',
    description: 'Run this session on a remote server (dsh-ssh-fleet)',
    input: { hint: '[<host> [dir] | local | list | check [host] | reload]' },
    handler: async ({ agent, rawInput, signal }) => {
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      try {
        if (args.length === 0 || args[0] === 'list' || args[0] === 'status') return { kind: 'success', text: status(fleet, agent) }
        if (args[0] === 'help') return { kind: 'success', text: USAGE }
        if (args[0] === 'reload') {
          const count = await fleet.reloadHosts()
          return { kind: 'success', text: `Reloaded ${count} server(s).\n${status(fleet, agent)}` }
        }
        if (args[0] === 'check') return { kind: 'success', text: await check(fleet, args[1] ?? fleet.bindingOf(agent.session)?.hostId) }
        if (args[0] === 'local') return await unbind(ctx, fleet, agent, signal)
        if (args.length > 2) return { kind: 'error', text: USAGE }
        return await bind(ctx, fleet, agent, args[0], args[1], signal)
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} agent
 */
function status(fleet, agent) {
  const binding = fleet.bindingOf(agent.session)
  const lines = [binding === null
    ? 'This session runs locally.'
    : `This session runs on ${binding.hostId}${binding.root ? ` in ${binding.root}` : ''} (bound by ${binding.source}).`]
  if (fleet.hosts.size === 0) {
    lines.push(`No servers configured. Add them to ${fleet.config.hostsFile} and run /ssh reload.`)
    return lines.join('\n')
  }
  lines.push('Servers:')
  for (const entry of fleet.hosts.values()) {
    const c = entry.config
    const dest = `${c.user ? `${c.user}@` : ''}${c.host}${c.port ? `:${c.port}` : ''}`
    const state = entry.info !== undefined ? `connected ${entry.info.os}/${entry.info.arch}` : entry.lastError ? `error: ${entry.lastError.split('\n')[0]}` : 'idle'
    const mark = binding?.hostId === entry.id ? '*' : '-'
    lines.push(`${mark} ${entry.id}  ${dest}  workspace ${c.workspace ?? '~'}  [${state}]${c.description ? `  ${c.description}` : ''}`)
  }
  lines.push('Bind with /ssh <server> [dir]; return with /ssh local.')
  return lines.join('\n')
}

/**
 * @param {import('./fleet.js').Fleet} fleet
 * @param {string | undefined} hostId
 */
async function check(fleet, hostId) {
  const ids = hostId === undefined ? [...fleet.hosts.keys()] : [hostId]
  const lines = []
  for (const id of ids) {
    const entry = fleet.entry(id)
    try {
      const started = Date.now()
      const info = await entry.ready()
      const probe = await entry.ssh.exec(['true'])
      lines.push(`${id}: ok, ${info.os}/${info.arch}, home ${info.home}, round trip ${Date.now() - started} ms`
        + `${probe.code === 0 ? '' : ' (probe failed)'}; rg: ${entry.rgPath ?? info.commands.rg ?? 'missing'}`
        + `; bwrap: ${info.commands.bwrap ?? 'missing'}; proxy: ${entry.proxyPort === undefined ? 'off' : `127.0.0.1:${entry.proxyPort}`}`)
    } catch (error) {
      lines.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return lines.join('\n') || 'No servers configured.'
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} agent
 * @param {string} hostId
 * @param {string | undefined} dir
 * @param {AbortSignal} signal
 */
async function bind(ctx, fleet, agent, hostId, dir, signal) {
  const entry = fleet.entry(hostId)
  const info = await entry.ready()
  const requested = fleet.expandRemote(dir ?? entry.config.workspace ?? '~', info.home)
  if (!requested.startsWith('/')) return { kind: 'error', text: `Remote directory must be absolute or start with ~/: ${requested}` }
  const target = await entry.fs.resolve(requested, signal)
  const stat = await entry.fs.stat(target, signal)
  if (stat?.type !== 'directory') return { kind: 'error', text: `${hostId}:${target.displayPath} is not a directory.` }
  const warnings = []
  await Promise.all(fleet.mirrors.hostDirs.map(hostDir => fleet.mirrors.ensure(entry.ssh, hostDir).catch((error) => {
    warnings.push(`mirror ${hostDir}: ${error instanceof Error ? error.message : String(error)}`)
  })))
  const previous = fleet.recordedBinding(agent.session)
  fleet.record(agent.session, hostId, target.displayPath)
  try {
    await ctx.agents.withInitiator(agent, () => ctx.workingDirectory.set(agent, target.displayPath, signal))
  } catch (error) {
    // Restore the earlier routing so the Session's directory stays valid.
    fleet.record(agent.session, previous?.hostId ?? null, previous?.root)
    throw error
  }
  const proxy = entry.proxyPort === undefined ? '' : ` HTTP(S)_PROXY points at the host proxy (127.0.0.1:${entry.proxyPort}).`
  return {
    kind: 'success',
    text: `Session bound to ${hostId} (${info.os}/${info.arch}); working directory ${target.displayPath}.${proxy}`
      + (warnings.length > 0 ? ` Warnings: ${warnings.join('; ')}` : ''),
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./fleet.js').Fleet} fleet
 * @param {any} agent
 * @param {AbortSignal} signal
 */
async function unbind(ctx, fleet, agent, signal) {
  const previous = fleet.bindingOf(agent.session)
  if (previous === null) return { kind: 'success', text: 'This session already runs locally.' }
  // An anchor directory would bind the Session again on the next request.
  const candidates = [agent.session.header.cwd, ctx.workingDirectory.defaultDirectory, homedir()]
  const directory = candidates.find(dir => typeof dir === 'string' && fleet.anchorHostOf(dir) === undefined) ?? homedir()
  fleet.record(agent.session, null)
  try {
    await ctx.agents.withInitiator(agent, () => ctx.workingDirectory.set(agent, directory, signal))
  } catch (error) {
    fleet.record(agent.session, previous.hostId, previous.root)
    throw error
  }
  return { kind: 'success', text: `Session returned to the local machine; working directory ${directory}.` }
}
