export declare const DSH_VERSION = "0.2.1-rc.2";
export declare const NODE_VERSION = "24.19.0";
export declare const NODE_SHA256: {
    readonly 'linux-x64': "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4";
    readonly 'linux-arm64': "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f";
    readonly 'darwin-x64': "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316";
    readonly 'darwin-arm64': "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d";
};
export type Target = keyof typeof NODE_SHA256;
export type SetupPhase = 'detecting' | 'preparing' | 'uploading' | 'verifying';
export type Progress = (phase: SetupPhase) => void;
export interface HelperBundle {
    key: string;
    archive: string;
    archiveHash: string;
    helperHash: string;
    nodeHash: string;
    verifierHash: string;
    manifestHash: string;
}
export declare const HELPER_PATH = "node_modules/@deepseek-ai/dsh-ssh/lib/helper.js";
export declare function sha256(path: string): Promise<string>;
export declare function isTarget(value: string): value is Target;
export declare function bundleKey(target: Target): Promise<string>;
export declare function prepareBundle(target: Target, stateDir: string, timeoutMs: number): Promise<HelperBundle>;
