import type { SandboxEnforcement, SandboxPolicy, SandboxProvider } from '@deepseek-ai/dsh-sandbox';
export interface SandboxCheck {
    status: 'selected' | 'unavailable' | 'error';
    backend?: string;
    enforcement?: SandboxEnforcement;
    message: string;
}
export interface SandboxChecks {
    host: SandboxCheck;
    remote: SandboxCheck;
}
/** The official SSH provider wraps an already formatted remote error a second time. */
export declare function sandboxError(error: unknown, policy: SandboxPolicy, location: string): unknown;
/**
 * Backend selection only. Linux's official provider performs functional probes
 * here; sole-candidate backends may defer validation until execution. Never
 * spawn the returned argv, grant writes, or infer that every command will work.
 */
export declare function checkSandbox(provider: Pick<SandboxProvider, 'confine'>, workspaceRoot: string, location: string, timeoutMs?: number): Promise<SandboxCheck>;
