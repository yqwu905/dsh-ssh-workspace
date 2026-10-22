export declare const shellQuote: (value: string) => string;
export interface CommandOptions {
    cwd?: string;
    input?: string;
    inputFile?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
}
export declare function command(executable: string, args: string[], options?: CommandOptions): Promise<string>;
export declare function sshCommand(host: string, script: string, options?: CommandOptions): Promise<string>;
