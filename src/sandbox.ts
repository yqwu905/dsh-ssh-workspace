import type { Context } from '@deepseek-ai/cordis'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import LocalSandboxProvider, { type Config } from '@deepseek-ai/dsh-sandbox-local'

const BWRAP_DENIAL_SIGNATURES = ['read-only file system'] as const
const BWRAP_RUNNER_FAILURE_RULES = [{ fatalSignatures: ['bwrap: '] }] as const

/** Build a bubblewrap profile whose paths belong to the SSH execution world. */
export function remoteBwrapArgv(
  argv: readonly string[],
  policy: SandboxPolicy,
  remoteWorkspaceRoot: string,
): string[] {
  const profile = [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ]
  if (policy.mode === 'workspace-write') {
    profile.push('--tmpfs', '/tmp', '--bind', remoteWorkspaceRoot, remoteWorkspaceRoot)
  }
  return [...profile, '--', ...argv]
}

/**
 * Use DSH's native sandbox for host workspaces and a fail-closed bubblewrap
 * profile for SSH workspaces. The latter is executed by the SSH subprocess
 * provider, so no host path or host sandbox runner leaks into the remote argv.
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
    return {
      argv: remoteBwrapArgv(argv, policy, routed.remotePath),
      enforcement: 'full',
      denialSignatures: BWRAP_DENIAL_SIGNATURES,
      runnerFailureRules: BWRAP_RUNNER_FAILURE_RULES,
    }
  }
}

export default SshSandboxProvider
