/** SSHFS understands only a whitelist of SSH -o options. Keep SSH policy in
 * ssh_command, where OpenSSH parses it, rather than leaking it to FUSE. This
 * command is fixed; server aliases and paths remain separate argv entries.
 */
export declare const SSHFS_SSH_COMMAND = "ssh -a -oBatchMode=yes -oStrictHostKeyChecking=yes -oServerAliveInterval=10 -oServerAliveCountMax=3";
export declare function sshfsArguments(host: string, remotePath: string, mountPath: string): string[];
