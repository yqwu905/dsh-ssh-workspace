# dsh-ssh-workspace

An SSH remote-workspace bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It replaces the `ctx.fs` and `ctx.subprocess` capability providers together, so the existing agent tools operate in one remote execution world without tool-specific forks.

[简体中文](README.zh-CN.md)

## Capabilities

- Configure a host, port, user, private key / ssh-agent / environment-only password, and strict host-key fingerprint verification.
- Auto-register remote directories as DSH workspaces. The Web “Add workspace” flow browses and creates remote directories too.
- Run file reads, writes, literal edits, and directory listings over SFTP.
- Run Bash, background jobs, grep/glob, LSP, PTY terminals, and out-of-process subagents through SSH by replacing the shared subprocess seam.
- Keep source files remote. The host stores only empty workspace anchors under `~/.dsh/ssh-workspaces/` by default.

```text
Agent tools
  ├─ read/write/edit ── ctx.fs ────────── SFTP ── remote files
  └─ bash/grep/LSP/PTY ─ ctx.subprocess ─ SSH ─── remote processes

DSH workspace registry ─ local empty anchor ─ path mapper ─ remote directory
```

## Install and configure

```sh
npm ci
npm pack
dsh plugin --profile web add ./dsh-ssh-workspace-0.1.0.tgz

export DSH_SSH_HOST=ssh.example.com
export DSH_SSH_PORT=22
export DSH_SSH_USER=developer
export DSH_SSH_ROOT=/srv/projects
export DSH_SSH_PRIVATE_KEY="$HOME/.ssh/id_ed25519"
export DSH_SSH_HOST_KEY_SHA256='SHA256:VERIFIED_FINGERPRINT'
export DSH_SSH_WORKSPACES='[{"path":"/srv/projects/api","title":"API server"}]'

dsh --profile web
```

For a direct source-directory install, run `npm ci && npm run build` first and
then pass `./dsh-ssh-workspace` to `dsh plugin add`. The published package
bundles ssh2's pure JavaScript / Node crypto path and has no install-time build
scripts or optional native accelerator approval requirement.

DSH profiles disable automatic peer installation, so pnpm may print a peer
dependency warning. The profile's DSH base / Web bundles provide those peers;
an actual module-not-found error instead means the profile bundle versions are
not compatible with `0.1.0-rc.7`.

Use `DSH_SSH_PASSWORD` and `DSH_SSH_PASSPHRASE` only as environment variables; plaintext secrets are not accepted in plugin config. Authentication falls back to `SSH_AUTH_SOCK`, then common private-key paths.

The host-key fingerprint is mandatory by default. Obtain a candidate with:

```sh
ssh-keyscan -p 22 ssh.example.com 2>/dev/null | ssh-keygen -lf - -E sha256
```

Verify it through an independent trusted channel. `DSH_SSH_ACCEPT_UNKNOWN_HOST_KEY=1` is an explicit insecure opt-out for disposable test hosts only.

For YAML configuration, override the `ssh-workspace-runtime` row in a later profile patch. See [`examples/cordis.patch.yml`](examples/cordis.patch.yml).

The bundle replaces DSH's adaptive directory-picker backend and explicitly mounts the browse UI surface, so **Choose workspace** navigates the configured SSH root in Web profiles instead of opening a host-native folder dialog.

Host-side workspace anchors are canonicalized before registration. This keeps DSH's canonical session `cwd` (including host aliases such as macOS `/private/tmp`) mapped to the corresponding remote directory for Bash and other subprocess consumers.

## Requirements and boundaries

- Compatible with DeepSeek Harness `0.1.0-rc.7`; Node.js `^22.19.0` or `>=24`.
- The remote host is POSIX. Bash/search/LSP/subagent features require their corresponding executables on that host.
- `root` bounds file operations, directory browsing, and accepted process working directories. It is not a command sandbox: a Bash command has the SSH user's full authority and can access paths outside `root` from inside the command. Use a dedicated low-privilege account or server-side isolation.
- The bundle keeps `dsh-bash-sandbox` only as DSH's shell capability wrapper and pins the sole permission preset to `danger-full-access`. That mode does not invoke the host sandbox; command authority is exactly the configured SSH user's server-side authority.
- One plugin instance represents one server and one remote root.
- `~/.ssh/config`, ProxyJump, and ProxyCommand are not currently parsed.
- Atomic replace/create requires the OpenSSH `posix-rename` and `hardlink` SFTP extensions.
- SSH transport closure cannot prove that deliberately daemonized remote descendants exited. PTY foreground-PGID inspection is unavailable, so terminal readiness uses Harness's bounded silence fallback.
- Collected output keeps a bounded tail and does not create spill files.

Deleting a DSH workspace or its empty local anchor never deletes remote files.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run test:bundle
npm run test:loopback
npm run build
npm run pack:check
```

Default tests are offline. `test:loopback` starts an ephemeral server on `127.0.0.1` and verifies Cordis startup, host-key checking, password auth, SFTP resolve/stat, stdin forwarding, remote execution, and output collection. Testing server-specific OpenSSH extensions still requires a separately supplied host and credentials.
