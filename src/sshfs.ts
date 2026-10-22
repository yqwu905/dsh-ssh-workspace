/** SSHFS understands only a whitelist of SSH -o options. Keep SSH policy in
 * ssh_command, where OpenSSH parses it, rather than leaking it to FUSE. This
 * command is fixed; server aliases and paths remain separate argv entries.
 */
export const SSHFS_SSH_COMMAND = 'ssh -a -oBatchMode=yes -oStrictHostKeyChecking=yes -oServerAliveInterval=10 -oServerAliveCountMax=3'

export function sshfsArguments(host: string, remotePath: string, mountPath: string): string[] {
  return [
    `${host}:${remotePath}`, mountPath, '-f',
    '-o', `ssh_command=${SSHFS_SSH_COMMAND}`,
    '-o', 'cache=no', '-o', 'attr_timeout=0', '-o', 'entry_timeout=0', '-o', 'negative_timeout=0',
    '-o', 'default_permissions', '-o', 'follow_symlinks',
  ]
}
