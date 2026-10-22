import type { Context } from '@deepseek-ai/cordis';
import schema from '@deepseek-ai/schemastery';
export declare const name = "ssh-workspaces";
export declare const inject: string[];
export interface Config {
    stateDir: string;
    mountRoot: string;
    requestTimeoutMs: number;
    mountTimeoutMs: number;
    sshfsBinary: string;
    helperInstallTimeoutMs: number;
}
export declare const Config: schema<Config>;
/** Install without changing the user's profiles, plugin catalog, model settings or credentials. */
export declare function apply(ctx: Context, config: Config): Promise<void>;
