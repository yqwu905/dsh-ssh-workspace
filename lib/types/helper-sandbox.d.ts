export declare const SANDBOX_LOCAL_SHA256 = "be6e1107871cf8d94c040090b13c405bc833822e2f51ed5280e93eececf762be";
/** Reject wrong-architecture or dynamically linked artifacts before uploading them. */
export declare function validateStaticElf(bytes: Buffer, arch: 'x64' | 'arm64'): void;
/**
 * Narrow adapter for the pinned published provider. Both probing and execution
 * use the same selected absolute path. Its profiles, enforcement facts and
 * Landlock fallback remain upstream-owned; no runnerCommand override is used.
 */
export declare function adaptSandboxSource(source: string): string;
export declare function installBundledSandbox(payload: string, target: string): Promise<void>;
