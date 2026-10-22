/** Diagnose confinement without relaxing the consumer's policy or executing its command. */
import { basename } from 'node:path'
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { SandboxEnforcement, SandboxPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox'

export interface SandboxCheck {
  status: 'selected' | 'unavailable' | 'error'
  backend?: string
  enforcement?: SandboxEnforcement
  message: string
}
export interface SandboxChecks { host: SandboxCheck; remote: SandboxCheck }
const contextualized = Symbol('ssh-workspaces.sandbox-diagnostic')

function unavailable(error: unknown): error is Error {
  return error instanceof Error && ('code' in error && error.code === SANDBOX_UNAVAILABLE || error.name === 'SandboxUnavailableError')
}

/** The official SSH provider wraps an already formatted remote error a second time. */
export function sandboxError(error: unknown, policy: SandboxPolicy, location: string): unknown {
  if (!unavailable(error)) return error
  if (Reflect.get(error, contextualized)) return error
  const generic = new SandboxUnavailableError(policy.mode).message
  let detail = error.message
  while (detail === generic || detail.startsWith(`${generic} Runner failure: `)) {
    detail = detail === generic ? '' : detail.slice(`${generic} Runner failure: `.length)
  }
  const result = new SandboxUnavailableError(policy.mode)
  result.message = `${location}: cannot prepare sandbox mode "${policy.mode}". `
    + 'On the machine executing this command, Linux needs usable bubblewrap or an enforcing Landlock kernel; macOS needs usable sandbox-exec. '
    + 'An installed helper alone does not supply kernel/container permissions. '
    + 'The command was not executed; the sandbox policy was not changed. '
    + 'Use SSH Workspaces > Check connection and sandbox, then reconnect after repairing the backend.'
    + (detail ? ` Detail: ${detail}` : '')
  result.cause = error
  Object.defineProperty(result, contextualized, { value: true })
  return result
}

/**
 * Backend selection only. Linux's official provider performs functional probes
 * here; sole-candidate backends may defer validation until execution. Never
 * spawn the returned argv, grant writes, or infer that every command will work.
 */
export async function checkSandbox(
  provider: Pick<SandboxProvider, 'confine'>, workspaceRoot: string, location: string, timeoutMs = 10_000,
): Promise<SandboxCheck> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Sandbox preflight timed out')), timeoutMs)
  timer.unref()
  const policy: SandboxPolicy = { mode: 'read-only', workspaceRoot }
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
    })
    const result = await Promise.race([provider.confine(['/bin/true'], policy, controller.signal), cancelled])
    controller.signal.throwIfAborted()
    return { status: 'selected', backend: basename(result.argv[0] ?? 'unknown'), enforcement: result.enforcement,
      message: 'Read-only backend selection succeeded; each command still requires runtime enforcement.' }
  } catch (error) {
    const diagnostic = sandboxError(error, policy, location)
    return { status: unavailable(error) ? 'unavailable' : 'error', message: diagnostic instanceof Error ? diagnostic.message : String(diagnostic) }
  } finally { clearTimeout(timer) }
}
