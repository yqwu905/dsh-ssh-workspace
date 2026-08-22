import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from './index.js'

export const name = 'ssh-workspace-registrar'
export const inject = ['sshWorkspace', 'workspaceRegistry']

/** Build an unambiguous label for a workspace registered from an SSH server. */
export function remoteWorkspaceTitle(serverName: string, remotePath: string, configuredTitle?: string): string {
  const title = configuredTitle?.trim() || posix.basename(remotePath) || remotePath
  return `${serverName} / ${title}`
}

/** Register configured remote directories through deterministic local anchors. */
export async function apply(ctx: Context): Promise<void> {
  for (const server of ctx.sshWorkspace.listServers()) {
    for (const configured of server.config.workspaces) {
      const remote = await server.requireRemoteDirectory(configured.path)
      const anchor = await server.materializeAnchor(remote)
      await ctx.workspaceRegistry.create(anchor, remoteWorkspaceTitle(server.config.name, remote, configured.title))
    }
  }
}
