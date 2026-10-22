export declare const SSH_ALIAS: RegExp;
export interface ConfigHost {
    host: string;
    source: string;
}
export interface ConfigHosts {
    hosts: ConfigHost[];
    warnings: string[];
}
/** OpenSSH quotes, escapes, comments and key=value syntax; no shell expansion. */
export declare function configWords(line: string): string[];
export declare function discoverConfigHosts(home?: string): Promise<ConfigHosts>;
