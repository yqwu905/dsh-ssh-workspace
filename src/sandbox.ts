import type { Context } from '@deepseek-ai/cordis'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider, { type Config } from '@deepseek-ai/dsh-sandbox-local'
export { remoteBwrapArgv, remoteLandlockArgv } from './remote-sandbox.js'

/**
 * Use DSH's native sandbox for host workspaces and the functionally selected
 * remote bwrap/Landlock backend for SSH workspaces. The latter is executed by
 * the SSH subprocess provider, so no host path or host runner leaks into the
 * remote argv.
 */
export class SshSandboxProvider extends LocalSandboxProvider {
  static inject = ['sshWorkspace']
  static Config = LocalSandboxProvider.Config

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
  }

  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const routed = this.ctx.sshWorkspace.resolveAnchoredPath(policy.workspaceRoot)
    if (routed === undefined) return super.confine(argv, policy)
    return routed.server.confineSandbox(argv, policy, routed.remotePath)
  }
}

export default SshSandboxProvider
