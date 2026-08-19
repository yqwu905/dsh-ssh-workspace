# dsh-ssh-workspace

An SSH remote-workspace bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It replaces `ctx.fs` and `ctx.subprocess` together, so existing Agent tools operate in the matching server's remote execution world without tool-specific forks.

[简体中文](README.zh-CN.md)

## Capabilities

- Add, edit, and remove multiple SSH servers in **Settings → Plugins → SSH workspaces**.
- Configure each server's host, port, user, remote root, host-key fingerprint, startup workspaces, and authentication independently.
- Use private keys, ssh-agent, automatic authentication, or strict password-only authentication. Passwords go to the DSH credential store, never ordinary settings, and are never read back into the browser.
- Browse every configured server from **Add workspace**, then add or create a remote directory.
- Run Read, Write, Edit, and directory operations through SFTP.
- Run Bash, background jobs, Glob, Grep, LSP, PTY terminals, and out-of-process subagents through the selected server's SSH connection.
- Keep identically named paths on different servers isolated by a stable server ID.
- Keep source files remote. The host stores only empty workspace anchors under `~/.dsh/ssh-workspaces/` by default.

```text
DSH session cwd (local empty anchor)
  └─ server-aware path mapper
      ├─ Read / Write / Edit ── ctx.fs ───────── SFTP ── remote files
      └─ Bash / Glob / Grep ─── ctx.subprocess ─ SSH ─── remote processes
```

## Requirements

- A profile compatible with DeepSeek Harness `0.1.0-rc.7`.
- Node.js `^22.19.0` or `>=24`.
- Direct connectivity to a POSIX SSH server.
- Remote `bash` for Bash tools and remote `rg` (ripgrep) for Glob/Grep. LSP and subagent features require their corresponding remote executables.
- `~/.ssh/config`, ProxyJump, and ProxyCommand are not currently parsed.

## Install

Install the built tarball:

```sh
npm ci
npm pack
dsh plugin --profile web add ./dsh-ssh-workspace-0.1.0.tgz
```

For a source-directory install, build first:

```sh
npm ci
npm run build
dsh plugin --profile web add ./dsh-ssh-workspace
```

The package bundles ssh2's pure JavaScript / Node crypto path and has no install-time build scripts or optional native accelerator approval requirement. DSH profiles disable automatic peer installation, so pnpm may print a peer dependency warning; the profile's DSH base and Web bundles provide those peers.

## Configure multiple servers in the UI

1. Start the Web profile and open **Settings → Plugins → Plugin configuration**.
2. Open **SSH workspaces**, then select **Add SSH server**.
3. Enter a display name, host, port, username, remote root, and a SHA256 host-key fingerprint verified through a trusted channel.
4. Choose authentication:
   - **Private key / SSH agent** accepts a local key path on the DSH host. Blank uses ssh-agent or conventional key files.
   - **Password only** stores the entered password as a DSH credential and explicitly disables key discovery and ssh-agent fallback.
   - **Auto** combines the available private key, agent, or stored password.
5. Enter one absolute remote directory per line under **Startup workspaces**.
6. Save, then add any additional servers. Each one has its own connection, authentication, root, and workspace list.

The password field is write-only. After saving, the UI reports only that a password is configured. `passwordRef` in settings is a reference; the secret is held by [DSH credentials](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/credentials). The card uses DSH [settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings) and the documented [settings-card surface](https://deepseek-harness.github.io/deepseek-harness/en/reference/cookbook/adding-a-settings-card).

After saving, **Add workspace** shows all configured server names at its first level. Select one to browse beneath that server's remote root.

### Host keys

A SHA256 host-key fingerprint is mandatory by default. Obtain a candidate with:

```sh
ssh-keyscan -p 22 ssh.example.com 2>/dev/null | ssh-keygen -lf - -E sha256
```

`ssh-keyscan` does not establish identity by itself. Verify the fingerprint through a cloud console, operations channel, or the server itself. Allowing an unverified host key disables server identity verification and is intended only for disposable test hosts.

### Glob and Grep

DSH's search tools start a ripgrep binary packaged for the host platform. The plugin recognizes that binary, resolves `rg` on the remote server, and maps host-anchor arguments into that server's remote paths. Install ripgrep remotely or set **Remote ripgrep executable** to its absolute remote path.

## Headless and compatibility configuration

`servers` is the canonical multi-server configuration. `DSH_SSH_SERVERS` accepts the same JSON array. Keep plaintext secrets out of JSON and YAML; inject them through environment variables or DSH credentials.

```sh
export DSH_SSH_PASSWORD_STAGING='injected-through-a-secure-channel'
export DSH_SSH_SERVERS='[
  {
    "id":"prod-key",
    "name":"Production",
    "host":"prod.example.com",
    "port":22,
    "username":"developer",
    "root":"/srv/projects",
    "authMode":"key",
    "privateKeyPath":"~/.ssh/id_ed25519",
    "hostKeySha256":"SHA256:VERIFIED_PROD_FINGERPRINT",
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
    "hostKeySha256":"SHA256:VERIFIED_STAGING_FINGERPRINT",
    "workspaces":[{"path":"/home/tester/workspace","title":"Staging workspace"}]
  }
]'

dsh --profile web
```

Legacy single-server variables such as `DSH_SSH_HOST`, `DSH_SSH_USER`, and `DSH_SSH_ROOT` remain supported only when `servers` is empty. See [`examples/cordis.patch.yml`](examples/cordis.patch.yml) and [`examples/env.sh`](examples/env.sh).

## Workspace paths

DSH registers local directories as workspaces. The plugin therefore creates one deterministic, empty anchor tree per server, for example:

```text
~/.dsh/ssh-workspaces/prod-key/api
~/.dsh/ssh-workspaces/staging-password/workspace
```

A session stores the host anchor as its `cwd`. Before each operation, the filesystem and subprocess providers use the canonical real path and server ID to translate it back to the remote directory. This also normalizes aliases such as macOS `/private/tmp`. Anchors contain no source, and deleting a DSH workspace or anchor never deletes remote files.

## Security boundaries and limitations

- A server's `root` bounds file tools, directory browsing, and accepted process working directories. It is not a remote command sandbox: Bash has the SSH user's full authority and can access outside `root` from within a command. Use a dedicated low-privilege account or server-side isolation in production.
- A host sandbox cannot confine remote processes. The bundle retains `dsh-bash-sandbox` only as the DSH shell capability wrapper and pins the preset to `danger-full-access`; command authority is exactly the SSH user's server-side authority.
- Atomic SFTP replace/create requires OpenSSH `posix-rename` and `hardlink` extensions. Missing extensions fail explicitly rather than silently degrading to non-atomic writes.
- Closing an SSH channel cannot prove that deliberately daemonized remote descendants exited.
- PTY I/O and signals are supported, but SSH does not expose foreground PGID evidence; Harness uses bounded-silence fallback behavior.
- Collected output retains a bounded tail and does not create recoverable spill files.

## Development and E2E verification

```sh
npm ci
npm run typecheck
npm test
npm run test:bundle
npm run test:loopback
npm run build
npm run pack:check
```

`test:loopback` starts an ephemeral local SSH server and verifies password authentication, host-key checking, SFTP, and remote execution. Release acceptance should additionally install the current tarball into a real DSH profile, configure at least two logical servers through the Web UI, and exercise Read/Write/Bash/Glob/Grep in actual Agent sessions; ordinary unit tests do not replace that E2E step.
