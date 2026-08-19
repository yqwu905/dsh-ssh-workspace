# Example only. Source this file after replacing every value.
export DSH_SSH_HOST=ssh.example.com
export DSH_SSH_PORT=22
export DSH_SSH_USER=developer
export DSH_SSH_ROOT=/srv/projects
export DSH_SSH_PRIVATE_KEY="$HOME/.ssh/id_ed25519"
export DSH_SSH_HOST_KEY_SHA256='SHA256:REPLACE_WITH_VERIFIED_FINGERPRINT'
export DSH_SSH_WORKSPACES='[{"path":"/srv/projects/api","title":"API server"}]'
