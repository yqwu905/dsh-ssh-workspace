export declare const SANDBOX_LOCAL_SHA256 = "be6e1107871cf8d94c040090b13c405bc833822e2f51ed5280e93eececf762be";
export declare const LANDLOCK_JS_SHA256 = "a0f04e2990b6fff091d6776c41e56dac8c630a37b944632e743fa8f2ee9c4813";
/** Reject wrong-architecture or dynamically linked artifacts before uploading them. */
export declare function validateStaticElf(bytes: Buffer, arch: 'x64' | 'arm64'): void;
/**
 * Narrow adapter for the pinned published provider. Both probing and execution
 * use the same selected absolute path. Its profiles, enforcement facts and
 * Landlock fallback remain upstream-owned; no runnerCommand override is used.
 */
export declare function adaptSandboxSource(source: string): string;
/** Preserve the upstream probe verdict/parser; expose the same spawn's failure facts. */
export declare function adaptLandlockSource(source: string): string;
export declare function installBundledSandbox(payload: string, target: string): Promise<void>;
