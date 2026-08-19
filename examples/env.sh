# Example only. Source this file after replacing every value.
export DSH_SSH_PASSWORD_STAGING='INJECT_FROM_A_SECURE_CHANNEL'
export DSH_SSH_SERVERS='[
  {
    "id":"production",
    "name":"Production",
    "host":"prod.example.com",
    "port":22,
    "username":"developer",
    "root":"/srv/projects",
    "authMode":"key",
    "privateKeyPath":"~/.ssh/id_ed25519",
    "hostKeySha256":"SHA256:REPLACE_WITH_VERIFIED_PROD_FINGERPRINT",
    "workspaces":[{"path":"/srv/projects/api","title":"Production API"}]
  },
  {
    "id":"staging-password",
    "name":"Staging",
    "host":"staging.example.com",
    "port":22,
    "username":"tester",
    "root":"/home/tester",
    "authMode":"password",
    "passwordEnv":"DSH_SSH_PASSWORD_STAGING",
    "hostKeySha256":"SHA256:REPLACE_WITH_VERIFIED_STAGING_FINGERPRINT",
    "workspaces":[{"path":"/home/tester/workspace","title":"Staging workspace"}]
  }
]'
