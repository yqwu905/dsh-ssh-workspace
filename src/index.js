/**
 * dsh-ssh-fleet: run DeepSeek Harness sessions on many SSH servers from one
 * instance. The agent loop, model calls, plugins, skills and settings stay on
 * the host; each Session's files, commands, terminals and searches run on the
 * server it is bound to.
 * @module dsh-ssh-fleet
 */

import { readFileSync } from 'node:fs'
import { registerCommands } from './commands.js'
import { Config } from './config.js'
import { Fleet } from './fleet.js'
import { RoutedFileSystem, RoutedSandbox, RoutedSubprocess } from './router.js'
import { registerWebApi } from './web.js'

export const name = 'dsh-ssh-fleet'
export const inject = ['sshFleetLocal', 'sessions', 'agents', 'sandboxPolicy']
export { Config }

/** @param {string} path */
function readHostsFileSync(path) {
  if (path === '') return []
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (/** @type {any} */ (error).code === 'ENOENT') return []
    throw error
  }
  const parsed = JSON.parse(text)
  const hosts = Array.isArray(parsed) ? parsed : parsed?.hosts
  if (!Array.isArray(hosts)) throw new Error(`ssh-fleet: ${path} must contain an array or { "hosts": [...] }`)
  return hosts
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./config.js').FleetConfig} config
 */
export function apply(ctx, config) {
  const hosts = [...config.hosts, ...readHostsFileSync(config.hostsFile)]
  ctx.plugin(Fleet, { ...config, inlineHosts: config.hosts, hosts })
  ctx.plugin(RoutedFileSystem, { diffBasisMaxBytes: config.diffBasisMaxBytes })
  ctx.plugin(RoutedSubprocess)
  ctx.plugin(RoutedSandbox)

  // Browser API (Web profiles only): served inside the connection's
  // authentication fence.
  ctx.inject(['sshFleet', 'connection'], (c) => {
    registerWebApi(c, c.sshFleet)
  })

  ctx.inject(['sshFleet', 'commands', 'workingDirectory'], (c) => {
    registerCommands(c, c.sshFleet)
  })

  // Browser terminals are created by the terminal controller outside any
  // Agent run. Their calls (directory check, shell lookup, spawn) get the
  // owning Agent as initiator so they reach that Session's server.
  ctx.inject(['terminalController', 'agents'], (c) => {
    const controller = c.terminalController
    const methods = ['create', 'shells']
    for (const method of methods) {
      const original = controller[method]
      controller[method] = function (agent, ...rest) {
        return c.agents.withInitiator(agent, () => original.call(this, agent, ...rest))
      }
    }
    c.effect(() => () => {
      for (const method of methods) delete controller[method]
    })
  })

  // A Session whose working directory is an anchor `<anchorsDir>/<hostId>`
  // (created there, or moved there by cd / SDK setWorkingDirectory) is bound
  // to that server durably, and its directory moves to the server's
  // workspace before the request so the model, shells and searches see real
  // remote paths.
  ctx.inject(['sshFleet', 'workingDirectory'], (c) => {
    const fleet = c.sshFleet
    c.on('system-prompt/assemble', async (_assembly, context, next) => {
      const agent = context.agent
      if (agent !== undefined) {
        // An inherited (parent) binding becomes the Session's own record, so
        // it holds even when the parent is not loaded later.
        const inherited = fleet.bindingOf(agent.session)
        const inheritedEntry = inherited?.source === 'parent' ? fleet.hosts.get(inherited.hostId) : undefined
        if (inherited !== null && inheritedEntry !== undefined) {
          fleet.record(agent.session, inherited.hostId, inherited.root ?? await fleet.rootOf(inheritedEntry, inherited))
        }
        const current = c.workingDirectory.get(agent.session)
        const hostId = fleet.anchorHostOf(current)
        const entry = hostId === undefined ? undefined : fleet.hosts.get(hostId)
        if (entry !== undefined && hostId !== undefined) {
          await entry.ready()
          // The anchor names the remote directory; it is also the Session's
          // workspace root.
          const remote = entry.translate(current).path
          const requested = remote === fleet.expandRemote(entry.config.workspace ?? '~', entry.info?.home ?? '')
            ? await fleet.rootOf(entry, { hostId, source: 'anchor' })
            : remote
          fleet.record(agent.session, hostId, requested)
          const canonical = await c.workingDirectory.set(agent, requested, context.signal)
          if (canonical !== requested) fleet.record(agent.session, hostId, canonical)
        }
      }
      return await next()
    }, { prepend: true })
  })

  ctx.inject(['sshFleet', 'systemPrompt'], (c) => {
    const fleet = c.sshFleet
    c.systemPrompt.context({
      name: 'ssh-fleet:execution-host',
      order: c.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 1,
      required: true,
      interpolate: false,
      text: (context) => {
        const agent = context.agent
        if (agent === undefined) return ''
        const binding = fleet.bindingOf(agent.session)
        if (binding === null) return ''
        return `Execution host: remote server ${JSON.stringify(binding.hostId)}. File tools, shell commands, terminals `
          + 'and searches run on that server, not on the machine running DSH. Skill resources are mirrored onto the '
          + 'server; use the directories the skill tool reports.'
      },
    })
  })
}
