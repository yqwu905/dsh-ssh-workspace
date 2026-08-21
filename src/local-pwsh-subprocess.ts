import { Context } from '@deepseek-ai/cordis'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/** Native host subprocess provider reserved for the isolated Windows PowerShell stack. */
export class LocalPwshSubprocessRuntime extends LocalSubprocessRuntime {
  static inject = ['sshWorkspace']

  constructor(ctx: Context) {
    super(ctx)
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.assertLocalWorkspace(spec.cwd)
    return super.spawn(spec)
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    this.assertLocalWorkspace(spec.cwd)
    return await super.spawnTerminal(spec)
  }

  private assertLocalWorkspace(cwd: string): void {
    if (this.ctx.sshWorkspace.resolveAnchoredPath(cwd) === undefined) return
    throw new Error('dsh-ssh-workspace: PowerShell is available only in local workspaces; use Bash for SSH workspaces')
  }
}

export default LocalPwshSubprocessRuntime
