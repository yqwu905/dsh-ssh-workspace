# dsh-ssh-workspace

A mixed local/SSH workspace bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It installs routing `ctx.fs`, `ctx.subprocess`, and directory-picker providers: ordinary host paths keep using DSH's native local implementations, while deterministic SSH workspace anchors enter the matching server's remote execution world without tool-specific forks.

[简体中文](README.zh-CN.md)

## Capabilities

- Add, edit, and remove multiple SSH servers in **Settings → Plugins → SSH workspaces**.
- Configure each server's host, port, user, remote root, host-key fingerprint, startup workspaces, and authentication independently.
- Use private keys, ssh-agent, automatic authentication, or strict password-only authentication. Passwords go to the DSH credential store, never ordinary settings, and are never read back into the browser.
- Browse the local filesystem and every configured server from the same **Add workspace** flow.
- Keep existing local workspaces usable for Read, Write, Edit, the host-native shell (PowerShell on Windows), Glob, Grep, terminals, and other process-backed tools after SSH is configured.
- Run Read, Write, Edit, and directory operations through SFTP.
- Run Bash, background jobs, Glob, Grep, LSP, PTY terminals, and out-of-process subagents through the selected server's SSH connection.
- Keep DSH's `read-only`, `workspace-write` (default), and `danger-full-access` permission presets in both local and SSH workspaces.
- Keep identically named paths on different servers isolated by a stable server ID.
- Keep source files remote. The host stores only empty workspace anchors under `~/.dsh/ssh-workspaces/` by default.

```text
DSH session cwd
  ├─ ordinary local path ────── native fs / local subprocess / Windows pwsh
  └─ local empty SSH anchor ─── server-aware path mapper
      ├─ Read / Write / Edit ── SFTP ── remote files
      └─ Bash / Glob / Grep ─── SSH ─── remote processes
```

## Requirements

- A profile compatible with DeepSeek Harness `0.1.0-rc.7` or `0.1.1-rc.2`.
- Node.js `^22.19.0` or `>=24`.
- Direct connectivity to a POSIX SSH server.
- Remote `bash` for Bash tools and remote `rg` (ripgrep) for Glob/Grep. LSP and subagent features require their corresponding remote executables.
- Automatic remote sandbox selection for SSH Bash under `read-only` or `workspace-write`: a functional `bwrap` probe first, then a bundled static Landlock runner on Linux x64/ARM64. File tools enforce those modes through SFTP without either process runner. `danger-full-access` does not use them.
- On Windows hosts, local workspaces expose PowerShell while SSH workspaces continue to use Bash. PowerShell deliberately rejects an SSH-anchor working directory.
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

After saving, **Add workspace** shows **Local filesystem** followed by all configured server names. Select the local entry to browse host directories, or a server to browse beneath that server's remote root. The picker keeps a **Workspaces** breadcrumb so either world remains reachable without changing plugin configuration.

### Host keys

A SHA256 host-key fingerprint is mandatory by default. Obtain a candidate with:

```sh
ssh-keyscan -p 22 ssh.example.com 2>/dev/null | ssh-keygen -lf - -E sha256
```

`ssh-keyscan` does not establish identity by itself. Verify the fingerprint through a cloud console, operations channel, or the server itself. Allowing an unverified host key disables server identity verification and is intended only for disposable test hosts.

### Glob and Grep

DSH's search tools start a ripgrep binary packaged for the host platform. The plugin recognizes that binary, resolves `rg` on the remote server, and maps host-anchor arguments into that server's remote paths. Install ripgrep remotely or set **Remote ripgrep executable** to its absolute remote path.

### Permission presets

The bundle preserves DSH's standard presets instead of replacing them. `workspace-write` remains the default, `read-only` rejects Write/Edit and confines Bash to a read-only remote filesystem, and `danger-full-access` runs with the SSH user's authority. In `workspace-write`, remote Bash may write only inside the session workspace and its granted temporary area; SFTP Write/Edit may write only inside the session workspace.

Remote Bash confinement is enforced on the SSH server. At server initialization the plugin functionally probes bubblewrap; if bubblewrap is missing or cannot create its namespace, it uploads the version-pinned DSH Landlock launcher to the SSH user's private `~/.cache/dsh-ssh-workspace` directory, verifies its SHA-256, and probes actual kernel enforcement. The bundled launcher supports Linux x64 and ARM64 and requires an enabled Landlock LSM (kernel 5.13+; the probe, not the version string, is authoritative). If neither backend works, confined Bash fails closed with `SANDBOX_UNAVAILABLE` and reports both probe failures; it never retries unconfined.

Bubblewrap provides a private `/tmp` and PID namespace. Under the Landlock fallback, `workspace-write` grants the remote workspace, `/tmp`, and `/dev/null`; `/tmp` is the host's shared remote temp directory rather than a private mount. On an older supported Landlock ABI, DSH reports `enforcement: partial` instead of claiming full enforcement.

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

A remote session stores the host anchor as its `cwd`. Before each operation, the hybrid filesystem and subprocess providers use the canonical real path and server ID to translate it back to the remote directory. A local session retains its ordinary canonical host `cwd` and delegates to DSH's native local providers. Routing is therefore explicit and workspace-scoped rather than inferred from an absolute path that might exist in both worlds. This also normalizes aliases such as macOS `/private/tmp`. Anchors contain no source, and deleting a DSH workspace or anchor never deletes remote files. When a file path in a Read/Write/Edit tool row is opened with the host desktop, the plugin downloads a fresh read-only snapshot under the hidden `.open-cache` directory. Desktop edits are intentionally not synchronized back to SSH; use an SSH-aware editor for live remote editing.

## Security boundaries and limitations

- A server's `root` bounds file tools, directory browsing, and accepted process working directories. Under `read-only` and `workspace-write`, the selected remote process sandbox prevents Bash writes outside the policy roots but still permits reads outside the configured server `root`, matching DSH's file-effect-only sandbox contract. Use a dedicated low-privilege account for stronger confidentiality boundaries.
- A host sandbox cannot confine remote processes, so the mixed sandbox translates the session anchor into a remote path and selects bubblewrap or Landlock on the SSH server. If both are unusable, confined Bash fails closed. On Windows, local PowerShell remains in its isolated local shell/subprocess realm and cannot target an SSH anchor.
- `danger-full-access` deliberately bypasses sandboxing. Local commands then have the DSH host account's authority and SSH commands have the selected SSH user's authority.
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

`test:loopback` starts an ephemeral local SSH server and verifies password authentication, host-key checking, SFTP, remote execution, and local/SSH routing in one provider instance. Release acceptance should additionally install the current tarball into a real DSH profile, add at least one local workspace and two logical servers through the Web UI, and exercise Read/Write/Bash/Glob/Grep in both local and remote Agent sessions; ordinary unit tests do not replace that E2E step.
