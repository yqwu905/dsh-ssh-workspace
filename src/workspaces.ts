import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from './index.js'

export const name = 'ssh-workspace-registrar'
export const inject = ['sshWorkspace', 'workspaceRegistry']

/** Register configured remote directories through deterministic local anchors. */
export async function apply(ctx: Context): Promise<void> {
  for (const configured of ctx.sshWorkspace.config.workspaces) {
    const remote = await ctx.sshWorkspace.requireRemoteDirectory(configured.path)
    const anchor = await ctx.sshWorkspace.materializeAnchor(remote)
    await ctx.workspaceRegistry.create(anchor, configured.title)
  }
}
