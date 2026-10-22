import { type HelperBundle, type Progress, type Target } from './helper-bundle.js';
export interface Deployment {
    helper: string;
    helperHash: string;
    launch: {
        kind: 'node-script';
        node: string;
    };
}
export interface RemotePlatform {
    home: string;
    target: Target;
}
export declare function detectPlatform(host: string): Promise<RemotePlatform>;
/** Shell verifies the executable/verifier before executing either, then verifies the entire closure. */
export declare function verificationScript(directory: string, bundle: HelperBundle): string;
export declare function installationScript(directory: string, bundle: HelperBundle): string;
export declare function deployBundle(host: string, home: string, bundle: HelperBundle, timeoutMs: number, progress: Progress, previous?: string): Promise<Deployment>;
export declare function ensureHelper(host: string, stateDir: string, timeoutMs: number, progress: Progress, previous?: string): Promise<Deployment>;
