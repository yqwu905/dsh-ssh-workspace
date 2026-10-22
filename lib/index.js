// src/index.ts
import { homedir as homedir2 } from "node:os";
import { join as join4, isAbsolute as isAbsolute3 } from "node:path";
import schema from "@deepseek-ai/schemastery";

// src/manager.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { chmod as chmod2, lstat as lstat2, mkdir as mkdir2, open, readFile as readFile3, readlink, realpath as realpath2, rename as rename2, rmdir, symlink, unlink } from "node:fs/promises";
import { isAbsolute as isAbsolute2, join as join3, relative, resolve as resolve2, sep } from "node:path";
import { execFile, spawn as spawn2 } from "node:child_process";
import { promisify } from "node:util";
import { SshConnection } from "@deepseek-ai/dsh-ssh";
import { SshSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-ssh";
import { SshSandboxProvider } from "@deepseek-ai/dsh-sandbox-ssh";
import { SshFileSystem } from "@deepseek-ai/dsh-fs-ssh";
import { WorkspaceId } from "@deepseek-ai/dsh-workspace";
import { z as z2 } from "zod";

// src/config.ts
import { z } from "zod";
import { posix } from "node:path";
var clean = z.string().min(1).max(4096).refine((value) => !/[\0\r\n]/u.test(value), "NUL and line breaks are not allowed");
var absoluteRemotePath = clean.refine((value) => value.startsWith("/"), "Use an absolute remote POSIX path").transform((value) => posix.normalize(value));
var recordId = z.string().uuid();
var helperLaunch = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("executable") }).strict(),
  z.object({
    kind: z.literal("node-script"),
    node: absoluteRemotePath,
    bootstrapPath: absoluteRemotePath.optional(),
    bootstrapHash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
  }).strict().refine((value) => value.bootstrapPath === void 0 === (value.bootstrapHash === void 0), "bootstrap path and digest must be paired")
]);
var tunnelInput = z.object({
  remotePort: z.number().int().min(1024).max(65535),
  host: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
  port: z.number().int().min(1).max(65535)
}).strict();
var serverInput = z.object({
  id: recordId.optional(),
  label: clean.max(120),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/u, "Use an existing OpenSSH Host alias"),
  // Missing mode + existing helper is the v0.1 manual configuration; new records default to auto.
  helperMode: z.enum(["auto", "manual"]).optional(),
  helper: absoluteRemotePath.optional(),
  helperHash: z.string().regex(/^[a-f0-9]{64}$/u, "Expected lowercase SHA-256").optional(),
  launch: helperLaunch.optional(),
  tunnels: z.array(tunnelInput).max(16).default([]).refine((items) => new Set(items.map((item) => item.remotePort)).size === items.length, "Reverse tunnel ports must be unique"),
  executableMap: z.record(clean, clean).default({}),
  hostExecutables: z.array(clean).max(100).default([])
}).strict().superRefine((server, context) => {
  const mode = server.helperMode ?? (server.helper ? "manual" : "auto");
  if (mode === "manual" && (!server.helper || !server.helperHash || !server.launch)) {
    context.addIssue({ code: "custom", message: "Manual helper mode requires helper, helperHash and launch" });
  }
});
var workspaceInput = z.object({ serverId: recordId, remotePath: absoluteRemotePath, title: clean.max(120) }).strict();
var workspaceRecord = workspaceInput.extend({ id: recordId, mountPath: clean, workspaceId: z.string().optional() }).strict();
var persistedState = z.object({
  version: z.literal(1),
  servers: z.array(serverInput.safeExtend({ id: recordId })).max(100),
  workspaces: z.array(workspaceRecord).max(1e3),
  retiredMounts: z.array(workspaceRecord).default([])
}).strict().superRefine((state, context) => {
  const serverIds = new Set(state.servers.map((server) => server.id));
  if (serverIds.size !== state.servers.length) context.addIssue({ code: "custom", message: "Duplicate server id" });
  const allMounts = [...state.workspaces, ...state.retiredMounts];
  if (new Set(allMounts.map((workspace) => workspace.id)).size !== allMounts.length) context.addIssue({ code: "custom", message: "Duplicate live or retired workspace id" });
  for (const workspace of state.workspaces) if (!serverIds.has(workspace.serverId)) context.addIssue({ code: "custom", message: "Workspace references a missing server" });
});

// src/ssh-config.ts
import { glob, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
var SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/u;
function configWords(line) {
  const words = [];
  let word = "", quoted = false, escaped = false, started = false;
  for (const character of line) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && character === "#") break;
    if (!quoted && (/\s/u.test(character) || character === "=" && (words.length === 0 || words.length === 1 && !started))) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quoted || escaped) throw new Error("Unterminated quote or escape");
  if (started) words.push(word);
  return words;
}
async function discoverConfigHosts(home = homedir()) {
  const root2 = join(home, ".ssh");
  const hosts = /* @__PURE__ */ new Map(), visited = /* @__PURE__ */ new Set(), warnings = [];
  let bytes = 0;
  async function visit(file, depth) {
    if (depth > 16 || visited.size >= 128) {
      warnings.push("SSH Include limit reached (16 levels / 128 files).");
      return;
    }
    let canonical, contents;
    try {
      canonical = await realpath(file);
      if (visited.has(canonical)) return;
      visited.add(canonical);
      const info = await stat(canonical);
      if (!info.isFile() || (bytes += info.size) > 1024 * 1024) {
        warnings.push(`SSH config size limit: ${file}`);
        return;
      }
      contents = await readFile(canonical, "utf8");
    } catch (error) {
      if (file === join(root2, "config") && error.code === "ENOENT") return;
      warnings.push(`Cannot read SSH config: ${file}`);
      return;
    }
    for (const line of contents.split(/\r?\n/u)) {
      let words;
      try {
        words = configWords(line);
      } catch {
        warnings.push(`Invalid SSH config quoting in ${file}`);
        continue;
      }
      const [key, ...values] = words;
      if (key?.toLowerCase() === "host") {
        for (const host of values) {
          if (SSH_ALIAS.test(host) && !hosts.has(host) && hosts.size < 2e3) hosts.set(host, { host, source: file });
        }
      } else if (key?.toLowerCase() === "include") {
        for (let pattern of values) {
          pattern = pattern.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu, (_match, name2) => process.env[name2] ?? "${" + name2 + "}");
          pattern = pattern.replaceAll("%d", home).replaceAll("%%", "%");
          if (pattern.startsWith("~/")) pattern = join(home, pattern.slice(2));
          if (pattern.startsWith("~") || /[%$\0\r\n{}]/u.test(pattern)) {
            warnings.push(`Unsupported SSH Include expansion in ${file}`);
            continue;
          }
          pattern = isAbsolute(pattern) ? pattern : resolve(root2, pattern);
          try {
            const paths = [];
            for await (const path of glob(pattern)) {
              paths.push(path);
              if (paths.length >= 128) break;
            }
            for (const path of paths.sort()) await visit(path, depth + 1);
          } catch {
            warnings.push(`Cannot expand SSH Include in ${file}`);
          }
        }
      }
    }
  }
  await visit(join(root2, "config"), 0);
  return { hosts: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)), warnings: [...new Set(warnings)] };
}

// src/sshfs.ts
var SSHFS_SSH_COMMAND = "ssh -a -oBatchMode=yes -oStrictHostKeyChecking=yes -oServerAliveInterval=10 -oServerAliveCountMax=3";
function sshfsArguments(host, remotePath, mountPath) {
  return [
    `${host}:${remotePath}`,
    mountPath,
    "-f",
    "-o",
    `ssh_command=${SSHFS_SSH_COMMAND}`,
    "-o",
    "cache=no",
    "-o",
    "attr_timeout=0",
    "-o",
    "entry_timeout=0",
    "-o",
    "negative_timeout=0",
    "-o",
    "default_permissions",
    "-o",
    "follow_symlinks"
  ];
}

// src/helper-install.ts
import { randomUUID } from "node:crypto";
import { posix as posix2 } from "node:path";

// src/commands.ts
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
var shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function command(executable, args, options = {}) {
  return new Promise((resolve3, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    let force;
    const stop = (error) => {
      failure ??= error;
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 2e3);
      force.unref();
    };
    const timer = setTimeout(() => stop(new Error(`${executable} timed out`)), options.timeoutMs ?? 3e4);
    child.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
      if (stdout.length > 1024 * 1024) stop(new Error(`${executable} output limit exceeded`));
    });
    child.stderr.on("data", (data) => {
      stderr = (stderr + data.toString("utf8")).slice(-8192);
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (force) clearTimeout(force);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${executable} failed (${code}): ${stderr.trim() || stdout.trim()}`));
      else resolve3(stdout);
    });
    if (options.inputFile) void pipeline(createReadStream(options.inputFile), child.stdin).catch((error) => {
      if (error.code !== "EPIPE") stop(error);
    });
    else {
      child.stdin.on("error", () => {
      });
      child.stdin.end(options.input);
    }
  });
}
function sshCommand(host, script, options = {}) {
  if (!SSH_ALIAS.test(host)) throw new Error("Invalid OpenSSH alias");
  return command("ssh", [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    // Bootstrap must also work before a ControlMaster exists; do not reuse a stale configured master.
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    host,
    `sh -c ${shellQuote(script)}`
  ], options);
}

// src/helper-bundle.ts
import { createHash } from "node:crypto";
import { createReadStream as createReadStream2 } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile as readFile2, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
var DSH_VERSION = "0.2.1-rc.2";
var NODE_VERSION = "24.19.0";
var NODE_SHA256 = {
  "linux-x64": "f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4",
  "linux-arm64": "d28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f",
  "darwin-x64": "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
  "darwin-arm64": "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
};
var HELPER_PATH = "node_modules/@deepseek-ai/dsh-ssh/lib/helper.js";
var runtimeDirectory = fileURLToPath(new URL("../runtime/", import.meta.url));
var pending = /* @__PURE__ */ new Map();
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream2(path)) hash.update(part);
  return hash.digest("hex");
}
function isTarget(value) {
  return Object.hasOwn(NODE_SHA256, value);
}
async function bundleKey(target) {
  const hash = createHash("sha256").update(`managed-runtime-v1:${target}:${NODE_SHA256[target]}`);
  for (const name2 of ["package.json", "package-lock.json", "verify.mjs"]) hash.update(await readFile2(join2(runtimeDirectory, name2)));
  return `${DSH_VERSION}-${target}-${hash.digest("hex").slice(0, 20)}`;
}
async function prepareBundle(target, stateDir, timeoutMs) {
  const key = await bundleKey(target), cache = join2(stateDir, "helper-cache", key);
  const active = pending.get(cache);
  if (active) return active;
  const build = prepare(target, key, cache, timeoutMs);
  pending.set(cache, build);
  try {
    return await build;
  } finally {
    pending.delete(cache);
  }
}
async function prepare(target, key, cache, timeoutMs) {
  try {
    const saved = JSON.parse(await readFile2(join2(cache, "bundle.json"), "utf8"));
    const archive = join2(cache, "runtime.tar.gz");
    if (saved.key === key && /^[a-f0-9]{64}$/u.test(saved.archiveHash) && await sha256(archive) === saved.archiveHash) return { ...saved, archive };
  } catch {
  }
  const parent = join2(cache, "..");
  await mkdir(parent, { recursive: true, mode: 448 });
  const staging = await mkdtemp(join2(parent, ".prepare-"));
  try {
    const payload = join2(staging, "payload");
    await mkdir(payload, { mode: 448 });
    for (const name2 of ["package.json", "package-lock.json", "verify.mjs"]) await copyFile(join2(runtimeDirectory, name2), join2(payload, name2));
    const [platform, arch] = target.split("-");
    const version = (await command("npm", ["--version"])).trim();
    if (Number(version.split(".")[0]) < 10) throw new Error("Automatic helper preparation requires npm >= 10 on the Host");
    await command(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--omit=dev",
        "--include=optional",
        "--no-audit",
        "--no-fund",
        "--bin-links=false",
        `--os=${platform}`,
        `--cpu=${arch}`,
        ...platform === "linux" ? ["--libc=glibc"] : []
      ],
      { cwd: payload, timeoutMs }
    );
    const pty = join2(payload, "node_modules/node-pty/prebuilds", target);
    await lstat(join2(pty, "pty.node"));
    if (platform === "darwin") await chmod(join2(pty, "spawn-helper"), 493);
    await lstat(join2(payload, `node_modules/@deepseek-ai/node-addon-system-${target}/bin`, platform === "linux" ? "glibc/system.node" : "system.node"));
    await lstat(join2(payload, `node_modules/@koromix/koffi-${target}`));
    const nodeName = `node-v${NODE_VERSION}-${target}`;
    const archive = join2(parent, `${nodeName}.tar.gz`);
    if (await sha256(archive).catch(() => "") !== NODE_SHA256[target]) {
      const download = join2(staging, "node.tar.gz");
      await command("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "20",
        "--max-time",
        String(Math.ceil(timeoutMs / 1e3)),
        "--retry",
        "2",
        "--output",
        download,
        `https://nodejs.org/dist/v${NODE_VERSION}/${nodeName}.tar.gz`
      ], { timeoutMs });
      if (await sha256(download) !== NODE_SHA256[target]) throw new Error("Official Node archive checksum mismatch");
      await rename(download, archive);
    }
    await mkdir(join2(payload, "node"));
    await command("tar", ["-xzf", archive, "--no-same-owner", "-C", join2(payload, "node"), "--strip-components=1", `${nodeName}/bin/node`, `${nodeName}/LICENSE`], { timeoutMs });
    await chmod(join2(payload, "node/bin/node"), 493);
    const files = [];
    async function walk(directory, prefix = "") {
      for (const name2 of (await readdir(directory)).sort()) {
        const path = join2(directory, name2), info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error(`Unexpected link in helper closure: ${prefix}${name2}`);
        if (info.isDirectory()) await walk(path, prefix + name2 + "/");
        else if (info.isFile()) files.push({ path: prefix + name2, sha256: await sha256(path), mode: info.mode & 365 });
        else throw new Error("Unexpected special file in helper closure");
      }
    }
    await walk(payload);
    await writeFile(join2(payload, "payload-manifest.json"), JSON.stringify({ format: 1, platform, arch, nodeVersion: NODE_VERSION, files }));
    const result = {
      key,
      archive: join2(cache, "runtime.tar.gz"),
      archiveHash: "",
      helperHash: await sha256(join2(payload, HELPER_PATH)),
      nodeHash: await sha256(join2(payload, "node/bin/node")),
      verifierHash: await sha256(join2(payload, "verify.mjs")),
      manifestHash: await sha256(join2(payload, "payload-manifest.json"))
    };
    const list = join2(staging, "files.list");
    await writeFile(list, [...files.map((file) => file.path), "payload-manifest.json"].join("\0") + "\0");
    await command("tar", ["-czf", join2(staging, "runtime.tar.gz"), "-C", payload, "--no-recursion", "--null", "-T", list], { timeoutMs });
    result.archiveHash = await sha256(join2(staging, "runtime.tar.gz"));
    await writeFile(join2(staging, "bundle.json"), JSON.stringify(result), { mode: 384 });
    await rm(payload, { recursive: true, force: true });
    await rm(list);
    try {
      await rename(cache, `${cache}.old-${Date.now()}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(staging, cache);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// src/helper-install.ts
async function detectPlatform(host) {
  const output = await sshCommand(host, `set -eu
cd "$HOME"
printf '\\nDSH_PLATFORM_BEGIN\\n'
pwd -P
uname -s
uname -m
printf 'DSH_PLATFORM_END\\n'`);
  const match = /(?:^|\n)DSH_PLATFORM_BEGIN\n([^\n]+)\n([^\n]+)\n([^\n]+)\nDSH_PLATFORM_END(?:\n|$)/u.exec(output);
  if (!match) throw new Error("Cannot read the remote platform and home directory");
  const home = match[1], os = match[2], machine = match[3];
  const platform = os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : os;
  const arch = ["x86_64", "amd64"].includes(machine) ? "x64" : ["aarch64", "arm64"].includes(machine) ? "arm64" : machine;
  const target = `${platform}-${arch}`;
  if (!isTarget(target)) throw new Error(`Automatic helper installation supports Linux/macOS x64/arm64; detected ${target}`);
  if (!home.startsWith("/") || /[\0\r\n]/u.test(home) || home === "/") throw new Error("Remote account needs a normal absolute home directory");
  return { home: posix2.normalize(home), target };
}
var hashFunction = `hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else echo 'sha256sum or shasum is required on the SSH server' >&2; return 1; fi
}`;
function verificationScript(directory, bundle) {
  return `${hashFunction}
[ ! -L ${shellQuote(directory)} ]
[ "$(hash_file ${shellQuote(posix2.join(directory, "node/bin/node"))})" = ${shellQuote(bundle.nodeHash)} ]
[ "$(hash_file ${shellQuote(posix2.join(directory, "verify.mjs"))})" = ${shellQuote(bundle.verifierHash)} ]
[ "$(hash_file ${shellQuote(posix2.join(directory, "payload-manifest.json"))})" = ${shellQuote(bundle.manifestHash)} ]
${shellQuote(posix2.join(directory, "node/bin/node"))} ${shellQuote(posix2.join(directory, "verify.mjs"))} ${shellQuote(bundle.manifestHash)}`;
}
function installationScript(directory, bundle) {
  const parent = posix2.dirname(directory), staging = `${directory}.staging`;
  return `set -eu
umask 077
base=${shellQuote(parent)}
stage=${shellQuote(staging)}
dest=${shellQuote(directory)}
mkdir -p "$base"
[ "$(cd "$base" && pwd -P)" = "$base" ] || { echo 'Runtime parent must not contain symlinks' >&2; exit 1; }
[ ! -e "$dest" ] && [ ! -L "$dest" ]
mkdir "$stage"
cleanup() { chmod -R u+w "$stage" 2>/dev/null || true; rm -rf "$stage"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
cat > "$stage/archive.tar.gz"
${hashFunction}
[ "$(hash_file "$stage/archive.tar.gz")" = ${shellQuote(bundle.archiveHash)} ] || { echo 'Uploaded archive checksum mismatch' >&2; exit 1; }
mkdir "$stage/runtime"
tar -xzpf "$stage/archive.tar.gz" --no-same-owner -C "$stage/runtime"
chmod -R a-w "$stage/runtime"
${verificationScript(posix2.join(staging, "runtime"), bundle)}
chmod u+w "$stage/runtime"
mv "$stage/runtime" "$dest"
chmod a-w "$dest"
printf 'DSH_HELPER_INSTALLED\\n'`;
}
async function deployBundle(host, home, bundle, timeoutMs, progress, previous) {
  const parent = posix2.join(home, ".local/share/dsh-ssh-workspaces/runtimes");
  const prefix = `${parent}/${bundle.key}-`;
  if (previous?.endsWith("/" + HELPER_PATH)) {
    const directory2 = previous.slice(0, -HELPER_PATH.length - 1);
    if (directory2.startsWith(prefix) && /^[a-f0-9-]{36}$/u.test(directory2.slice(prefix.length))) {
      progress("verifying");
      try {
        const check2 = await sshCommand(host, `set -eu
${verificationScript(directory2, bundle)}`, { timeoutMs });
        if (check2.trim().endsWith("DSH_HELPER_READY")) return { helper: previous, helperHash: bundle.helperHash, launch: { kind: "node-script", node: posix2.join(directory2, "node/bin/node") } };
      } catch {
      }
    }
  }
  const directory = prefix + randomUUID();
  progress("uploading");
  const output = await sshCommand(host, installationScript(directory, bundle), { inputFile: bundle.archive, timeoutMs });
  if (!output.trim().endsWith("DSH_HELPER_INSTALLED")) throw new Error("Remote helper installation did not complete");
  progress("verifying");
  const check = await sshCommand(host, `set -eu
${verificationScript(directory, bundle)}`, { timeoutMs });
  if (!check.trim().endsWith("DSH_HELPER_READY")) throw new Error("Remote helper verification did not complete");
  return { helper: posix2.join(directory, HELPER_PATH), helperHash: bundle.helperHash, launch: { kind: "node-script", node: posix2.join(directory, "node/bin/node") } };
}
async function ensureHelper(host, stateDir, timeoutMs, progress, previous) {
  progress("detecting");
  const platform = await detectPlatform(host);
  progress("preparing");
  const bundle = await prepareBundle(platform.target, stateDir, timeoutMs);
  return deployBundle(host, platform.home, bundle, timeoutMs, progress, previous);
}

// src/manager.ts
var run = promisify(execFile);
var wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
var message = (error) => error instanceof Error ? error.message : String(error);
var missing = (error) => error instanceof Error && "code" in error && error.code === "ENOENT";
function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}
function mountinfoContains(contents, mountPath) {
  return contents.split("\n").some((line) => {
    const separator = line.indexOf(" - ");
    if (separator < 0) return false;
    const before = line.slice(0, separator).split(" ");
    const after = line.slice(separator + 3).split(" ");
    return before[4] !== void 0 && decodeMountPath(before[4]) === mountPath && /^(fuse\.sshfs|fusefs|osxfuse|macfuse)$/u.test(after[0] ?? "");
  });
}
var SshWorkspaceManager = class {
  constructor(ctx, options) {
    this.ctx = ctx;
    if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("SSH workspaces require a Linux/macOS host; use WSL2 on Windows");
    for (const field of ["stateDir", "mountRoot"]) if (!isAbsolute2(options[field])) throw new Error(`${field} must be an absolute host path`);
    this.options = {
      stateDir: resolve2(options.stateDir),
      mountRoot: resolve2(options.mountRoot),
      requestTimeoutMs: options.requestTimeoutMs ?? 3e4,
      mountTimeoutMs: options.mountTimeoutMs ?? 2e4,
      sshfsBinary: options.sshfsBinary ?? "sshfs",
      helperInstallTimeoutMs: options.helperInstallTimeoutMs ?? 6e5
    };
    if (this.options.stateDir === "/" || this.options.mountRoot === "/") throw new Error("State and mounts require dedicated directories");
    this.ready = this.initialize();
  }
  ready;
  options;
  servers = /* @__PURE__ */ new Map();
  workspaces = /* @__PURE__ */ new Map();
  retiredMounts = /* @__PURE__ */ new Map();
  remotes = /* @__PURE__ */ new Map();
  mounts = /* @__PURE__ */ new Map();
  connectJobs = /* @__PURE__ */ new Map();
  tail = Promise.resolve();
  disposed = false;
  /** Browser projection; errors never include credential file contents. */
  state() {
    return { servers: [...this.servers.values()].map((value) => structuredClone(value)), workspaces: [...this.workspaces.values()].map((value) => structuredClone(value)) };
  }
  configHosts() {
    return discoverConfigHosts();
  }
  /** Start a durable-in-process operation; a browser refresh must not cancel deployment. */
  beginConnect(id) {
    const server = this.requireServer(id);
    if (this.disposed) throw new Error("SSH workspace plugin is stopping");
    if (this.connectJobs.has(id) || server.status === "connected") return this.state();
    server.status = "connecting";
    delete server.error;
    const job = this.connect(id);
    this.connectJobs.set(id, job);
    void job.catch((error) => {
      server.status = "error";
      server.error = message(error);
    }).finally(() => this.connectJobs.delete(id));
    return this.state();
  }
  /** Includes offline records so a stale conversation can never fall through to local execution. */
  listMounts() {
    const live = [...this.workspaces.values()].map((workspace) => ({
      serverId: workspace.serverId,
      localPath: workspace.mountPath,
      remotePath: workspace.remotePath,
      executableMap: this.requireServer(workspace.serverId).executableMap,
      hostExecutables: this.requireServer(workspace.serverId).hostExecutables,
      status: workspace.status
    }));
    const retired = [...this.retiredMounts.values()].map((workspace) => ({
      serverId: workspace.serverId,
      localPath: workspace.mountPath,
      remotePath: workspace.remotePath,
      executableMap: {},
      hostExecutables: [],
      status: "unmounted"
    }));
    return [...live, ...retired];
  }
  /** Returns a provider only after the helper and all requested tunnels are ready. */
  getRemote(serverId) {
    return this.servers.get(serverId)?.status === "connected" ? this.remotes.get(serverId) : void 0;
  }
  upsertServer(input) {
    return this.enqueue(async () => {
      const parsed = serverInput.parse(input);
      const id = parsed.id ?? randomUUID2();
      if (parsed.id !== void 0 && !this.servers.has(id)) throw new Error("Unknown SSH server");
      if (this.connectJobs.has(id) || this.remotes.has(id) || this.hasMounted(id)) throw new Error("Disconnect this server before editing its connection settings");
      const previous = this.servers.get(id);
      const helperMode = parsed.helperMode ?? (parsed.helper ? "manual" : "auto");
      const reusable = helperMode === "auto" && previous?.helperMode === "auto" && previous.host === parsed.host ? { helper: previous.helper, helperHash: previous.helperHash, launch: previous.launch } : {};
      this.servers.set(id, { ...parsed, ...reusable, helperMode, id, status: "disconnected" });
      try {
        await this.save();
      } catch (error) {
        if (previous) this.servers.set(id, previous);
        else this.servers.delete(id);
        throw error;
      }
      return this.state();
    });
  }
  removeServer(id) {
    return this.enqueue(async () => {
      const server = this.requireServer(id);
      if (this.connectJobs.has(id)) throw new Error("Wait for helper installation/connection to finish");
      if ([...this.workspaces.values()].some((workspace) => workspace.serverId === id)) throw new Error("Remove this server\u2019s SSH workspace registrations first");
      await this.disconnectInternal(id);
      this.servers.delete(id);
      try {
        await this.save();
      } catch (error) {
        this.servers.set(id, server);
        throw error;
      }
      return this.state();
    });
  }
  connect(id) {
    return this.enqueue(async () => {
      await this.connectInternal(id);
      return this.state();
    });
  }
  disconnect(id) {
    return this.enqueue(async () => {
      this.requireServer(id);
      const owned = [...this.workspaces.values()].filter((workspace) => workspace.serverId === id);
      for (const workspace of owned) await this.assertInactive(workspace);
      for (const workspace of owned) await this.unmountInternal(workspace);
      await this.disconnectInternal(id);
      return this.state();
    });
  }
  addWorkspace(input) {
    return this.enqueue(async () => {
      const parsed = workspaceInput.parse(input);
      this.requireServer(parsed.serverId);
      const remote = await this.connectInternal(parsed.serverId);
      const target = await remote.fs.resolve(parsed.remotePath);
      if ((await remote.fs.stat(target))?.type !== "directory") throw new Error("The remote workspace must be an existing directory");
      const remotePath = remote.fs.processPath(target);
      await this.assertRuntimeOutside(parsed.serverId, remotePath, remote);
      const duplicate = [...this.workspaces.values()].find((workspace2) => workspace2.serverId === parsed.serverId && workspace2.remotePath === remotePath);
      if (duplicate) {
        await this.mountInternal(duplicate);
        return this.state();
      }
      const id = randomUUID2();
      const workspace = { ...parsed, id, remotePath, mountPath: join3(this.options.mountRoot, id), status: "unmounted" };
      this.workspaces.set(id, workspace);
      try {
        await this.save();
      } catch (error) {
        this.workspaces.delete(id);
        throw error;
      }
      await this.mountInternal(workspace);
      return this.state();
    });
  }
  mountWorkspace(id) {
    return this.enqueue(async () => {
      await this.mountInternal(this.requireWorkspace(id));
      return this.state();
    });
  }
  unmountWorkspace(id) {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(id);
      await this.assertInactive(workspace);
      await this.unmountInternal(workspace);
      return this.state();
    });
  }
  removeWorkspace(id) {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(id);
      await this.assertInactive(workspace);
      await this.unmountInternal(workspace);
      if (workspace.workspaceId !== void 0) await this.ctx.workspaceRegistry.delete(WorkspaceId(workspace.workspaceId));
      this.workspaces.delete(id);
      const { status: _status, error: _error, ...retired } = workspace;
      this.retiredMounts.set(id, retired);
      try {
        await this.save();
      } catch (error) {
        this.retiredMounts.delete(id);
        this.workspaces.set(id, workspace);
        throw error;
      }
      return this.state();
    });
  }
  probe(id) {
    return this.enqueue(async () => {
      const remote = await this.connectInternal(id);
      const hello = await remote.ssh.ready;
      const rg = await remote.subprocess.resolveExecutable("rg").catch(() => void 0);
      return { ok: true, message: `${hello.platform}; Node ${hello.nodeVersion}; helper SHA-256 verified; ${rg ? `ripgrep: ${rg}` : "ripgrep unavailable: install rg remotely for grep/glob"}` };
    });
  }
  /** Teardown does not replay any interrupted operation. Sessions remain durable in DSH. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await this.ready.catch(() => {
    });
    await this.tail;
    const errors = [];
    for (const workspace of this.workspaces.values()) {
      try {
        await this.unmountInternal(workspace);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const id of [...this.remotes.keys()]) {
      try {
        await this.disconnectInternal(id);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Some SSH resources could not be released; inspect mount state before restarting");
  }
  async initialize() {
    for (const directory of [this.options.stateDir, this.options.mountRoot]) {
      await mkdir2(directory, { recursive: true, mode: 448 });
      if (await realpath2(directory) !== directory) throw new Error("stateDir and mountRoot must be canonical directories, without symlink components");
      await chmod2(directory, 448);
    }
    let contents;
    try {
      contents = await readFile3(join3(this.options.stateDir, "state.json"), "utf8");
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    const state = persistedState.parse(JSON.parse(contents));
    for (const server of state.servers) this.servers.set(server.id, { ...server, helperMode: server.helperMode ?? (server.helper ? "manual" : "auto"), status: "disconnected" });
    for (const workspace of state.workspaces) {
      if (workspace.mountPath !== join3(this.options.mountRoot, workspace.id)) throw new Error("Stored mount path is outside the configured mount root");
      const view = { ...workspace, status: "unmounted" };
      this.workspaces.set(workspace.id, view);
      if (await this.isMounted(workspace.mountPath)) {
        view.status = "error";
        view.error = "An existing mount was found after restart. Unmount it explicitly, then reconnect; no existing transport was adopted.";
      } else await this.offlineMarker(workspace.mountPath);
    }
    for (const retired of state.retiredMounts) {
      if (retired.mountPath !== join3(this.options.mountRoot, retired.id)) throw new Error("Stored retired mount path is outside the configured mount root");
      this.retiredMounts.set(retired.id, retired);
      if (!await this.isMounted(retired.mountPath)) await this.offlineMarker(retired.mountPath);
    }
  }
  enqueue(operation) {
    const pending2 = this.tail.then(async () => {
      await this.ready;
      if (this.disposed) throw new Error("SSH workspace plugin is stopping");
      return operation();
    });
    this.tail = pending2.then(() => {
    }, () => {
    });
    return pending2;
  }
  async save() {
    const data = {
      version: 1,
      servers: [...this.servers.values()].map(({ status: _status, error: _error, setupPhase: _phase, ...server }) => server),
      workspaces: [...this.workspaces.values()].map(({ status: _status, error: _error, ...workspace }) => workspace),
      retiredMounts: [...this.retiredMounts.values()]
    };
    const temporary = join3(this.options.stateDir, `.state-${randomUUID2()}.json`);
    const file = await open(temporary, "wx", 384);
    try {
      await file.writeFile(`${JSON.stringify(data, null, 2)}
`);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename2(temporary, join3(this.options.stateDir, "state.json"));
      const directory = await open(this.options.stateDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => {
      });
      throw error;
    }
  }
  requireServer(id) {
    const server = this.servers.get(id);
    if (!server) throw new Error("Unknown SSH server");
    return server;
  }
  requireWorkspace(id) {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new Error("Unknown SSH workspace");
    return workspace;
  }
  hasMounted(serverId) {
    return [...this.workspaces.values()].some((workspace) => workspace.serverId === serverId && (workspace.status === "mounted" || workspace.status === "mounting"));
  }
  async connectInternal(id) {
    const server = this.requireServer(id);
    const existing = this.remotes.get(id);
    if (existing && server.status === "connected") return existing;
    if (existing) await this.disconnectInternal(id);
    server.status = "connecting";
    delete server.error;
    let remote;
    let fiber;
    try {
      if (server.helperMode === "auto" || !server.helperMode && !server.helper) {
        server.status = "installing";
        const deployment = await ensureHelper(server.host, this.options.stateDir, this.options.helperInstallTimeoutMs, (phase) => {
          server.setupPhase = phase;
        }, server.helper);
        Object.assign(server, deployment, { helperMode: "auto" });
        await this.save();
      }
      server.status = "connecting";
      delete server.setupPhase;
      const { helper, helperHash, launch } = server;
      if (!helper || !helperHash || !launch) throw new Error("SSH helper configuration is incomplete");
      const scoped = this.ctx.isolate("ssh").isolate("subprocess").isolate("sandbox").isolate("fs");
      fiber = scoped.plugin(async (child) => {
        const ssh = new SshConnection(child, {
          host: server.host,
          helper,
          helperHash,
          launch,
          workspace: "/",
          requestTimeoutMs: this.options.requestTimeoutMs,
          maxFrameBytes: 64 * 1024 * 1024,
          maxPending: 128,
          leaseMs: 3e4
        });
        await ssh.ready;
        remote = { ssh, subprocess: new SshSubprocessRuntime(child), sandbox: new SshSandboxProvider(child), fs: new SshFileSystem(child), fiber: child.fiber };
      });
      await fiber;
      if (remote === void 0) throw new Error("SSH helper failed to initialize; check its version, digest, and OpenSSH alias");
      if (server.tunnels.length > 0) remote.tunnel = await this.startTunnels(server);
      this.remotes.set(id, remote);
      server.status = "connected";
      const connected = remote;
      let checking = false;
      remote.heartbeat = setInterval(() => {
        if (checking || this.remotes.get(id) !== connected || server.status !== "connected") return;
        checking = true;
        void connected.ssh.request("heartbeat", {}, z2.null()).catch((error) => {
          if (this.remotes.get(id) === connected) {
            server.status = "error";
            server.error = message(error);
          }
        }).finally(() => {
          checking = false;
        });
      }, 1e4);
      remote.heartbeat.unref();
      return remote;
    } catch (error) {
      server.status = "error";
      server.error = message(error);
      delete server.setupPhase;
      await fiber?.dispose().catch(() => {
      });
      throw error;
    }
  }
  async disconnectInternal(id) {
    const server = this.requireServer(id);
    const remote = this.remotes.get(id);
    this.remotes.delete(id);
    server.status = "disconnected";
    delete server.error;
    delete server.setupPhase;
    if (!remote) return;
    if (remote.heartbeat) clearInterval(remote.heartbeat);
    if (remote.tunnel) await this.stopChild(remote.tunnel);
    await remote.fiber.dispose();
  }
  async assertRuntimeOutside(serverId, workspacePath, remote) {
    const server = this.requireServer(serverId);
    if (!server.helper || !server.launch) throw new Error("SSH helper is not installed");
    const runtimePaths = [server.helper];
    if (server.launch.kind === "node-script") {
      runtimePaths.push(server.launch.node);
      if (server.launch.bootstrapPath !== void 0) runtimePaths.push(server.launch.bootstrapPath);
    }
    for (const path of runtimePaths) {
      const target = await remote.fs.resolve(path);
      const canonical = remote.fs.processPath(target);
      if (workspacePath === "/" || canonical === workspacePath || canonical.startsWith(`${workspacePath}/`)) {
        throw new Error("Keep the SSH helper and its Node runtime outside writable workspaces");
      }
    }
  }
  async assertInactive(workspace) {
    if (workspace.workspaceId === void 0) return;
    const native = this.ctx.workspaceRegistry.get(WorkspaceId(workspace.workspaceId));
    for (const sessionId of native?.sessionIds ?? []) {
      const activities = await this.ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
      if (activities.length > 0) throw new Error("Stop active conversations, jobs, subagents, and schedules before unmounting this workspace");
    }
  }
  async mountInternal(workspace) {
    if (workspace.status === "mounted" && this.mounts.has(workspace.id)) {
      await this.connectInternal(workspace.serverId);
      return;
    }
    if (await this.isMounted(workspace.mountPath)) throw new Error("Mountpoint is already occupied. Unmount it explicitly before retrying.");
    const remote = await this.connectInternal(workspace.serverId);
    const target = await remote.fs.resolve(workspace.remotePath);
    if ((await remote.fs.stat(target))?.type !== "directory") throw new Error("Remote directory no longer exists");
    const canonical = remote.fs.processPath(target);
    await this.assertRuntimeOutside(workspace.serverId, canonical, remote);
    if (canonical !== workspace.remotePath) throw new Error("Remote directory now resolves to a different location; recreate its workspace registration");
    workspace.status = "mounting";
    delete workspace.error;
    await this.removeOfflineMarker(workspace.mountPath);
    await mkdir2(workspace.mountPath, { mode: 448 });
    const server = this.requireServer(workspace.serverId);
    const args = sshfsArguments(server.host, workspace.remotePath, workspace.mountPath);
    const child = spawn2(this.options.sshfsBinary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    let spawnError;
    child.stderr?.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-3e3);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const closed = new Promise((done) => {
      child.once("close", () => {
        if (workspace.status === "mounted" || workspace.status === "mounting") {
          workspace.status = "error";
          workspace.error = "SSHFS disconnected; reconnect explicitly. No command was replayed.";
          void this.isMounted(workspace.mountPath).then(async (mounted) => {
            if (!mounted) await this.offlineMarker(workspace.mountPath);
          }).catch((error) => {
            workspace.error = `SSHFS disconnected; offline marker failed: ${message(error)}`;
          });
        }
        this.mounts.delete(workspace.id);
        done();
      });
    });
    this.mounts.set(workspace.id, { process: child, closed });
    try {
      const deadline = Date.now() + this.options.mountTimeoutMs;
      while (!await this.isMounted(workspace.mountPath)) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`SSHFS failed: ${diagnostic || "process exited"}`);
        if (Date.now() >= deadline) throw new Error(`SSHFS mount timed out: ${diagnostic}`);
        await wait(100);
      }
      const native = await this.ctx.workspaceRegistry.create(workspace.mountPath, workspace.title);
      workspace.workspaceId = native.id;
      workspace.status = "mounted";
      await this.save();
    } catch (error) {
      workspace.status = "error";
      workspace.error = message(error);
      try {
        await this.unmountPhysical(workspace);
      } catch (cleanupError) {
        workspace.error += `; cleanup: ${message(cleanupError)}`;
      }
      throw error;
    }
  }
  async unmountInternal(workspace) {
    const oldStatus = workspace.status;
    workspace.status = "unmounted";
    try {
      await this.unmountPhysical(workspace);
      delete workspace.error;
    } catch (error) {
      workspace.status = "error";
      workspace.error = `Unmount failed (${oldStatus}): ${message(error)}`;
      throw error;
    }
  }
  async unmountPhysical(workspace) {
    if (await this.isMounted(workspace.mountPath)) {
      if (process.platform === "darwin") await run("umount", [workspace.mountPath], { timeout: this.options.requestTimeoutMs });
      else {
        try {
          await run("fusermount3", ["-u", workspace.mountPath], { timeout: this.options.requestTimeoutMs });
        } catch (error) {
          if (!missing(error)) throw error;
          await run("fusermount", ["-u", workspace.mountPath], { timeout: this.options.requestTimeoutMs });
        }
      }
      if (await this.isMounted(workspace.mountPath)) throw new Error("Filesystem remains mounted");
    }
    const running = this.mounts.get(workspace.id);
    if (running) {
      running.process.kill("SIGTERM");
      await Promise.race([running.closed, wait(1e3)]);
      if (running.process.exitCode === null && running.process.signalCode === null) running.process.kill("SIGKILL");
      await running.closed;
      this.mounts.delete(workspace.id);
    }
    await this.offlineMarker(workspace.mountPath);
  }
  async isMounted(path) {
    if (process.platform === "linux") return mountinfoContains(await readFile3("/proc/self/mountinfo", "utf8"), path);
    const { stdout } = await run("mount", [], { timeout: this.options.requestTimeoutMs });
    return stdout.split("\n").some((line) => line.includes(` on ${path} (`) && /(?:sshfs|macfuse|osxfuse|fusefs)/u.test(line));
  }
  async offlineMarker(path) {
    const rel = relative(this.options.mountRoot, path);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute2(rel) || rel.includes(sep)) throw new Error("Invalid mountpoint");
    let info;
    try {
      info = await lstat2(path);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (info?.isSymbolicLink()) {
      const expected = join3(this.options.stateDir, "offline-not-mounted", rel, "workspace");
      if (await readlink(path) !== expected) throw new Error("Offline mount marker has been changed");
      return;
    }
    if (info && !info.isDirectory()) throw new Error("Mountpoint has been replaced by a non-directory");
    if (info) await rmdir(path);
    await symlink(join3(this.options.stateDir, "offline-not-mounted", rel, "workspace"), path);
  }
  async removeOfflineMarker(path) {
    let info;
    try {
      info = await lstat2(path);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (info.isSymbolicLink()) await unlink(path);
    else if (info.isDirectory()) await rmdir(path);
    else throw new Error("Refusing to replace a non-directory mountpoint");
  }
  async startTunnels(server) {
    const controlPath = join3(this.options.stateDir, `t-${server.id.slice(0, 12)}`);
    if (Buffer.byteLength(controlPath) > 90) throw new Error("stateDir path is too long for an SSH control socket");
    const forwards = server.tunnels.flatMap((tunnel) => ["-R", `127.0.0.1:${tunnel.remotePort}:${tunnel.host === "::1" ? "[::1]" : tunnel.host}:${tunnel.port}`]);
    const child = spawn2("ssh", [
      "-NT",
      "-M",
      "-S",
      controlPath,
      "-o",
      "ControlPersist=no",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "GatewayPorts=no",
      "-o",
      "ServerAliveInterval=10",
      "-o",
      "ServerAliveCountMax=3",
      ...forwards,
      server.host
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    let launchError;
    child.stderr?.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-3e3);
    });
    child.once("error", (error) => {
      launchError = error;
    });
    try {
      const deadline = Date.now() + this.options.requestTimeoutMs;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`SSH reverse tunnel failed: ${diagnostic}`);
        try {
          await run("ssh", ["-S", controlPath, "-O", "check", server.host], { timeout: 2e3 });
          child.once("close", () => {
            const state = this.servers.get(server.id);
            if (state?.status === "connected" && this.remotes.get(server.id)?.tunnel === child) {
              state.status = "error";
              state.error = "SSH reverse tunnel disconnected; reconnect explicitly";
            }
          });
          return child;
        } catch {
          await wait(100);
        }
      }
      throw new Error(`SSH reverse tunnel timed out: ${diagnostic}`);
    } catch (error) {
      await this.stopChild(child);
      throw error;
    }
  }
  async stopChild(child) {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === void 0) return;
    const closed = new Promise((done) => {
      child.once("close", () => {
        done();
      });
    });
    child.kill("SIGTERM");
    await Promise.race([closed, wait(1e3)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
};

// src/routing.ts
import { posix as posix3 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function root(path) {
  if (!posix3.isAbsolute(path) || path.includes("\0")) throw new Error("SSH workspace paths must be absolute POSIX paths without NUL");
  return posix3.normalize(path).replace(/\/$/, "") || "/";
}
function isWithin(path, parent) {
  const relative2 = posix3.relative(root(parent), root(path));
  return relative2 === "" || relative2 !== ".." && !relative2.startsWith("../") && !posix3.isAbsolute(relative2);
}
function findMount(path, mounts) {
  if (!posix3.isAbsolute(path)) return void 0;
  return mounts.filter((mount) => isWithin(path, mount.localPath)).sort((a, b) => root(b.localPath).length - root(a.localPath).length)[0];
}
function mapPath(path, mount) {
  if (!posix3.isAbsolute(path) || !isWithin(path, mount.localPath)) return path;
  const prefix = root(mount.localPath);
  if (path !== prefix && !path.startsWith(prefix === "/" ? "/" : prefix + "/")) {
    throw new Error("Use the canonical workspace mount prefix; aliased prefix traversal cannot be translated safely.");
  }
  const suffix = path.slice(prefix.length);
  const remote = root(mount.remotePath);
  return prefix === "/" ? posix3.join(remote, suffix) : remote === "/" ? suffix || "/" : remote + suffix;
}
function shellLiteral(text, quote) {
  if (quote === "'") return text.replaceAll("'", "'\\''");
  if (quote === '"') return text.replace(/[\\$`\"]/g, "\\$&");
  return "'" + text.replaceAll("'", "'\\''") + "'";
}
function pathEnd(character) {
  return character === void 0 || character === "/" || /[\s'";|&()<>]/.test(character);
}
function mapShellCommand(command2, mount) {
  const local = root(mount.localPath);
  if (!command2.includes(local)) return command2;
  if (command2.includes("<<") || command2.includes("$(") || command2.includes("`")) {
    throw new Error("SSH path translation does not rewrite heredocs or command substitutions. Use a relative path from the workspace or its remote absolute path.");
  }
  let quote = "";
  let output = "";
  for (let index = 0; index < command2.length; ) {
    const character = command2[index];
    if (character === "\\" && quote !== "'") {
      if (command2.startsWith(local, index + 1)) {
        throw new Error("Use a quoted or relative workspace path instead of an escaped mount prefix.");
      }
      output += command2.slice(index, index + 2);
      index += 2;
      continue;
    }
    if ((character === "'" || character === '"') && (!quote || quote === character)) {
      quote = quote ? "" : character;
      output += character;
      index++;
      continue;
    }
    const previous = command2[index - 1];
    const startBoundary = index === 0 || previous !== void 0 && /[\s='";|&()<>:]/.test(previous);
    if (startBoundary && command2.startsWith(local, index) && pathEnd(command2[index + local.length])) {
      output += shellLiteral(root(mount.remotePath), quote);
      index += local.length;
      continue;
    }
    output += character;
    index++;
  }
  if (quote) throw new Error("Cannot translate workspace paths in shell source with an unterminated quote.");
  return output;
}
function mapArgument(argument, mount) {
  if (posix3.isAbsolute(argument)) return mapPath(argument, mount);
  const equals = argument.indexOf("=");
  if (equals >= 0 && argument.startsWith("-")) {
    return argument.slice(0, equals + 1) + mapPath(argument.slice(equals + 1), mount);
  }
  return argument;
}
function mapExecutable(program, mount) {
  const explicit = mount.executableMap?.[program];
  if (explicit !== void 0) {
    if (explicit.length === 0 || explicit.includes("\0")) throw new Error("An executableMap target must be a nonempty executable name or absolute path");
    return explicit;
  }
  if (isWithinIfAbsolute(program, mount.localPath)) return mapPath(program, mount);
  if (/\/(?:@vscode\/ripgrep|@vscode\+ripgrep[^/]*)\/.+\/rg$/.test(program)) return "rg";
  if (posix3.isAbsolute(program) && ["bash", "sh", "zsh", "fish"].includes(posix3.basename(program))) return posix3.basename(program);
  return program;
}
function isWithinIfAbsolute(path, parent) {
  return posix3.isAbsolute(path) && isWithin(path, parent);
}
function mapArgv(argv, mount) {
  if (!argv[0]) throw new Error("SSH subprocess argv must contain a program");
  const output = argv.map((argument) => mapArgument(argument, mount));
  output[0] = mapExecutable(argv[0], mount);
  const shell = posix3.basename(output[0]);
  if (["bash", "sh", "zsh", "dash", "ksh"].includes(shell)) {
    const commandOption = argv.findIndex((argument, index) => index > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(argument));
    if (commandOption >= 0 && argv[commandOption + 1] !== void 0) {
      output[commandOption + 1] = mapShellCommand(argv[commandOption + 1], mount);
    }
  }
  return output;
}
function discoverPtcBootstraps() {
  try {
    const entry = import.meta.resolve("@deepseek-ai/dsh-ptc-runtime-node/process");
    return [fileURLToPath2(entry), fileURLToPath2(new URL("./persistent-process.js", entry))];
  } catch {
    return [];
  }
}
var ptcBootstraps = discoverPtcBootstraps();
function isHostRuntime(argv, hostExecutables = [], bootstraps = ptcBootstraps) {
  if (argv[0] !== void 0 && hostExecutables.includes(argv[0])) return true;
  return argv.length === 4 && /^--max-old-space-size=\d+$/.test(argv[1] ?? "") && bootstraps.includes(argv[2] ?? "") && /^\d+$/.test(argv[3] ?? "");
}
function mapEnvironment(environment, mount) {
  if (environment === void 0) return void 0;
  return Object.fromEntries(Object.entries(environment).map(([name2, value]) => {
    if (value === void 0) return [name2, void 0];
    return [name2, name2 === "PATH" ? value.split(":").map((part) => mapPath(part, mount)).join(":") : mapPath(value, mount)];
  }));
}
function installRouting(ctx, manager) {
  if (process.platform === "win32") throw new Error("DSH SSH workspaces require a Linux/macOS host (use WSL2 on Windows).");
  const originalSymbol = Symbol.for("cordis.original");
  const raw = (value) => Reflect.get(value, originalSymbol) ?? value;
  const subprocess = raw(ctx.subprocess);
  const sandbox = raw(ctx.sandbox);
  const spawn3 = subprocess.spawn;
  const spawnTerminal = subprocess.spawnTerminal;
  const confine = sandbox.confine;
  const descriptors = {
    spawn: Object.getOwnPropertyDescriptor(subprocess, "spawn"),
    spawnTerminal: Object.getOwnPropertyDescriptor(subprocess, "spawnTerminal"),
    confine: Object.getOwnPropertyDescriptor(sandbox, "confine")
  };
  const confinedRoutes = /* @__PURE__ */ new WeakMap();
  let active = true;
  function ready(mount) {
    const provider = manager.getRemote(mount.serverId);
    if (mount.status !== void 0 && mount.status !== "mounted" || provider === void 0) {
      throw new Error(`SSH workspace ${mount.localPath} is offline. Reconnect and mount server ${mount.serverId}; refusing local execution.`);
    }
    return provider;
  }
  function route(spec) {
    const marked = confinedRoutes.get(spec.argv);
    const mount = findMount(spec.cwd, manager.listMounts());
    if (marked?.kind === "host") {
      if (mount !== void 0 && marked.exceptionServer !== mount.serverId) throw new Error("A host sandbox cannot enforce a remote subprocess; refusing execution.");
      if (mount !== void 0) ready(mount);
      return void 0;
    }
    if (marked?.kind === "remote") {
      if (mount === void 0 || mount.serverId !== marked.mount.serverId) throw new Error("Remote sandbox and subprocess execution worlds differ; refusing execution.");
      if (ready(mount) !== marked.provider) throw new Error("SSH connection changed after confinement; retry the entire tool call.");
      return { mount, provider: marked.provider, argv: spec.argv };
    }
    if (mount === void 0) return void 0;
    const provider = ready(mount);
    if (isHostRuntime(spec.argv, mount.hostExecutables)) return void 0;
    return { mount, provider, argv: mapArgv(spec.argv, mount) };
  }
  const routedSpawn = function(spec) {
    if (!active) return Reflect.apply(spawn3, this, [spec]);
    const selected = route(spec);
    if (selected === void 0) return Reflect.apply(spawn3, this, [spec]);
    const handle = selected.provider.subprocess.spawn({ ...spec, argv: selected.argv, cwd: mapPath(spec.cwd, selected.mount), env: mapEnvironment(spec.env, selected.mount) });
    const done = handle.done.catch((error) => {
      throw new Error(`Remote execution on ${selected.mount.serverId} failed: ${error instanceof Error ? error.message : String(error)}. Host-installed binaries need installation on the remote or an explicit executableMap/hostExecutables entry.`, { cause: error });
    });
    void done.catch(() => {
    });
    return new Proxy(handle, { get(target, property) {
      if (property === "done") return done;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const routedTerminal = async function(spec) {
    if (!active) return Reflect.apply(spawnTerminal, this, [spec]);
    const selected = route(spec);
    if (selected === void 0) return Reflect.apply(spawnTerminal, this, [spec]);
    return selected.provider.subprocess.spawnTerminal({ ...spec, argv: selected.argv, cwd: mapPath(spec.cwd, selected.mount), env: mapEnvironment(spec.env, selected.mount) });
  };
  const routedConfine = async function(argv, policy, signal) {
    if (!active) return Reflect.apply(confine, this, [argv, policy, signal]);
    const mount = findMount(policy.workspaceRoot, manager.listMounts());
    if (mount === void 0) {
      const result2 = await Reflect.apply(confine, this, [argv, policy, signal]);
      confinedRoutes.set(result2.argv, { kind: "host" });
      return result2;
    }
    const provider = ready(mount);
    if (isHostRuntime(argv, mount.hostExecutables)) {
      const result2 = await Reflect.apply(confine, this, [argv, policy, signal]);
      confinedRoutes.set(result2.argv, { kind: "host", exceptionServer: mount.serverId });
      return result2;
    }
    const mapped = mapArgv(argv, mount);
    mapped[0] = await provider.subprocess.resolveExecutable(mapped[0], void 0, signal);
    const result = await provider.sandbox.confine(mapped, { ...policy, workspaceRoot: mapPath(policy.workspaceRoot, mount) }, signal);
    confinedRoutes.set(result.argv, { kind: "remote", mount, provider });
    return result;
  };
  return ctx.effect(() => {
    subprocess.spawn = routedSpawn;
    subprocess.spawnTerminal = routedTerminal;
    sandbox.confine = routedConfine;
    return () => {
      active = false;
      const restore = (target, key, installed, descriptor) => {
        if (Reflect.get(target, key) !== installed) return;
        if (descriptor === void 0) Reflect.deleteProperty(target, key);
        else Object.defineProperty(target, key, descriptor);
      };
      restore(subprocess, "spawn", routedSpawn, descriptors.spawn);
      restore(subprocess, "spawnTerminal", routedTerminal, descriptors.spawnTerminal);
      restore(sandbox, "confine", routedConfine, descriptors.confine);
    };
  }, "ssh-workspaces.routing");
}

// src/fs-routing.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { posix as posix4 } from "node:path";
import { pathToFileURL } from "node:url";
import { FsError, FsTargetKey } from "@deepseek-ai/dsh-fs";
var targetPrefix = "dsh-ssh-workspace:";
function installFsRouting(ctx, manager) {
  const fs = Reflect.get(ctx.fs, Symbol.for("cordis.original")) ?? ctx.fs;
  const names = [
    "resolve",
    "processPath",
    "processPathFromHostPath",
    "fileUrl",
    "contains",
    "stat",
    "lstat",
    "readText",
    "streamText",
    "readBytes",
    "readByteRange",
    "listDir",
    "writeText",
    "editText",
    "watch"
  ];
  const originals = Object.fromEntries(names.map((name2) => [name2, fs[name2]]));
  const descriptors = new Map(names.map((name2) => [name2, Object.getOwnPropertyDescriptor(fs, name2)]));
  const generations = /* @__PURE__ */ new WeakMap();
  const targets = /* @__PURE__ */ new Map();
  let active = true;
  function local(name2, receiver, ...args) {
    return Reflect.apply(originals[name2], receiver, args);
  }
  function ready(mount) {
    const live = manager.listMounts().find((candidate) => candidate.serverId === mount.serverId && candidate.localPath === mount.localPath && candidate.remotePath === mount.remotePath);
    const remote = manager.getRemote(mount.serverId);
    if (live === void 0 || live.status !== void 0 && live.status !== "mounted" || remote === void 0) {
      throw new FsError(`SSH workspace ${mount.localPath} is offline; reconnect before accessing its files.`, "FS_IO_ERROR");
    }
    return remote;
  }
  function current(value) {
    const mount = manager.listMounts().find((candidate) => candidate.serverId === value.mount.serverId && candidate.localPath === value.mount.localPath);
    if (mount === void 0 || ready(mount) !== value.remote) {
      throw new FsError("SSH connection or workspace changed; resolve the file again before continuing.", "FS_IO_ERROR");
    }
    return value;
  }
  function selected(path, cwd) {
    const absolute = posix4.isAbsolute(path) ? path : cwd === void 0 ? void 0 : posix4.resolve(cwd, path);
    const mount = absolute === void 0 ? void 0 : findMount(absolute, manager.listMounts());
    const cwdMount = cwd === void 0 ? void 0 : findMount(cwd, manager.listMounts());
    if (!posix4.isAbsolute(path) && cwdMount !== void 0 && mount?.localPath !== cwdMount.localPath) {
      throw new FsError("Relative file path crosses an SSH workspace boundary. Use its registered absolute mount path.", "FS_PERMISSION_DENIED");
    }
    if (mount === void 0) {
      if (!posix4.isAbsolute(path) && cwd !== void 0 && findMount(cwd, manager.listMounts()) !== void 0) {
        throw new FsError("Relative file path escapes the SSH workspace. Choose an explicitly registered workspace.", "FS_PERMISSION_DENIED");
      }
      return void 0;
    }
    const remote = ready(mount);
    return {
      mount,
      remote,
      path: posix4.isAbsolute(path) ? mapPath(path, mount) : path,
      ...cwd === void 0 ? {} : { cwd: mapPath(cwd, mount) }
    };
  }
  function wrap(native, mount, remote) {
    const remotePath = remote.fs.processPath(native);
    if (!posix4.isAbsolute(remotePath) || !isWithin(remotePath, mount.remotePath)) {
      throw new FsError(`Remote path resolves outside the registered workspace ${mount.remotePath}; symlink escapes are not exposed through its host mount.`, "FS_PERMISSION_DENIED");
    }
    let generation = generations.get(remote);
    if (generation === void 0) {
      generation = randomUUID3();
      generations.set(remote, generation);
    }
    const key = targetPrefix + JSON.stringify([mount.serverId, generation, native.targetKey]);
    const path = posix4.join(mount.localPath, posix4.relative(mount.remotePath, remotePath));
    targets.set(key, { mount, remote, native, path });
    return { targetKey: FsTargetKey(key), displayPath: path };
  }
  function target(value) {
    const found = targets.get(String(value.targetKey));
    if (found !== void 0) return current(found);
    if (String(value.targetKey).startsWith(targetPrefix)) throw new FsError("Unknown or retired SSH file target; resolve the file again.", "FS_IO_ERROR");
    const path = Reflect.apply(originals.processPath, fs, [value]);
    if (findMount(path, manager.listMounts()) !== void 0) {
      throw new FsError("A pre-routing file target cannot access an SSH mount; resolve the file again.", "FS_IO_ERROR");
    }
    return void 0;
  }
  function policy(value, supplied) {
    const effective = supplied ?? ctx.sandboxPolicy.resolve();
    const owner = findMount(effective.workspaceRoot, manager.listMounts());
    if (owner !== void 0 && owner.serverId === value.mount.serverId) {
      if (ready(owner) !== value.remote) throw new FsError("Sandbox and file use different SSH connections.", "FS_IO_ERROR");
      return { ...effective, workspaceRoot: mapPath(effective.workspaceRoot, owner) };
    }
    if (effective.mode === "workspace-write") {
      throw new FsError("The file policy workspace is not on this SSH server; refusing mutation.", "FS_SANDBOX_DENIED");
    }
    return { ...effective, workspaceRoot: value.mount.remotePath };
  }
  const wrappers = {
    async resolve(path, opts) {
      if (!active) return local("resolve", this, path, opts);
      const route = selected(path, opts?.cwd);
      if (route === void 0) return local("resolve", this, path, opts);
      const native = await route.remote.fs.resolve(route.path, { cwd: route.cwd, signal: opts?.signal });
      if (ready(route.mount) !== route.remote) throw new FsError("SSH connection changed during file resolution; retry.", "FS_IO_ERROR");
      return wrap(native, route.mount, route.remote);
    },
    processPath(value) {
      if (!active) return local("processPath", this, value);
      return target(value)?.path ?? local("processPath", this, value);
    },
    processPathFromHostPath(path) {
      if (active) {
        const mount = findMount(path, manager.listMounts());
        if (mount !== void 0) {
          ready(mount);
          return path;
        }
      }
      return local("processPathFromHostPath", this, path);
    },
    fileUrl(value) {
      if (!active) return local("fileUrl", this, value);
      const route = target(value);
      return route === void 0 ? local("fileUrl", this, value) : pathToFileURL(route.path).href;
    },
    contains(parent, child) {
      if (!active) return local("contains", this, parent, child);
      const a = target(parent), b = target(child);
      if (a === void 0 && b === void 0) return local("contains", this, parent, child);
      return a !== void 0 && b !== void 0 && a.mount.serverId === b.mount.serverId && a.remote === b.remote && a.remote.fs.contains(a.native, b.native);
    },
    async stat(value, signal) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("stat", this, value, signal) : route.remote.fs.stat(route.native, signal);
    },
    async lstat(path, opts, signal) {
      const route = active ? selected(path, opts?.cwd) : void 0;
      if (route === void 0) return local("lstat", this, path, opts, signal);
      const absolute = posix4.isAbsolute(route.path) ? route.path : (route.cwd ?? route.mount.remotePath) + "/" + route.path;
      if (absolute === route.mount.remotePath) return route.remote.fs.lstat(absolute, void 0, signal);
      const parent = await route.remote.fs.resolve(posix4.dirname(absolute), { signal });
      wrap(parent, route.mount, route.remote);
      return route.remote.fs.lstat(posix4.join(route.remote.fs.processPath(parent), posix4.basename(absolute)), void 0, signal);
    },
    async readText(value, signal) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("readText", this, value, signal) : route.remote.fs.readText(route.native, signal);
    },
    async streamText(value, signal) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("streamText", this, value, signal) : route.remote.fs.streamText(route.native, signal);
    },
    async readBytes(value, signal, maxBytes) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("readBytes", this, value, signal, maxBytes) : route.remote.fs.readBytes(route.native, signal, maxBytes);
    },
    async readByteRange(value, range, signal) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("readByteRange", this, value, range, signal) : route.remote.fs.readByteRange(route.native, range, signal);
    },
    async listDir(value, signal) {
      const route = active ? target(value) : void 0;
      if (route === void 0) return local("listDir", this, value, signal);
      const entries = await route.remote.fs.listDir(route.native, signal);
      current(route);
      return entries.map((entry) => ({ ...entry, target: wrap(entry.target, route.mount, route.remote) }));
    },
    async writeText(value, content, expected, signal, supplied) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("writeText", this, value, content, expected, signal, supplied) : route.remote.fs.writeText(route.native, content, expected, signal, policy(route, supplied));
    },
    async editText(value, edit, expected, signal, supplied) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("editText", this, value, edit, expected, signal, supplied) : route.remote.fs.editText(route.native, edit, expected, signal, policy(route, supplied));
    },
    async watch(value, changed, signal) {
      const route = active ? target(value) : void 0;
      return route === void 0 ? local("watch", this, value, changed, signal) : route.remote.fs.watch(route.native, changed, signal);
    }
  };
  return ctx.effect(() => {
    for (const name2 of names) Object.defineProperty(fs, name2, { configurable: true, writable: true, value: wrappers[name2] });
    return () => {
      active = false;
      for (const name2 of names) {
        if (Reflect.get(fs, name2) !== wrappers[name2]) continue;
        const descriptor = descriptors.get(name2);
        if (descriptor === void 0) Reflect.deleteProperty(fs, name2);
        else Object.defineProperty(fs, name2, descriptor);
      }
      targets.clear();
    };
  }, "ssh-workspaces.fs-routing");
}

// src/http.ts
var API_PATH = "/api/ssh-workspaces";
var HttpError = class extends Error {
  constructor(status, message2) {
    super(message2);
    this.status = status;
  }
};
function send(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(data));
}
async function json(req) {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Use application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > 64 * 1024) {
      req.resume();
      throw new HttpError(413, "Management request exceeds 64 KiB.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}
function managementHandler(api, fence) {
  return async (req, res) => {
    const rejected = fence(req);
    if (rejected !== void 0) {
      send(res, rejected, { error: "DSH authentication or origin check failed." });
      return;
    }
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== API_PATH && !path.startsWith(API_PATH + "/")) throw new HttpError(404, "Unknown route.");
      const route = path.slice(API_PATH.length).split("/").filter(Boolean);
      if (req.method === "GET" && route.length === 1 && route[0] === "ssh-config") {
        send(res, 200, await api.configHosts());
        return;
      }
      if (req.method === "GET" && (route.length === 0 || route.length === 1 && route[0] === "state")) {
        send(res, 200, api.state());
        return;
      }
      if (req.method !== "POST" && req.method !== "DELETE") throw new HttpError(405, "Use GET, POST or DELETE.");
      if (route.length === 1 && req.method === "POST") {
        const body = await json(req);
        if (route[0] === "servers") await api.upsertServer(body);
        else if (route[0] === "workspaces") await api.addWorkspace(body);
        else throw new HttpError(404, "Unknown resource.");
      } else {
        const [resource, id, action] = route;
        if (!id || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || route.length > 3) throw new HttpError(400, "Invalid resource ID.");
        if (req.method === "DELETE" && route.length === 2) {
          if (resource === "servers") await api.removeServer(id);
          else if (resource === "workspaces") await api.removeWorkspace(id);
          else throw new HttpError(404, "Unknown resource.");
        } else if (req.method === "POST" && route.length === 3) {
          if (resource === "servers" && action === "connect") {
            send(res, 202, api.beginConnect(id));
            return;
          } else if (resource === "servers" && action === "disconnect") await api.disconnect(id);
          else if (resource === "servers" && action === "probe") {
            const result = await api.probe(id);
            send(res, 200, result);
            return;
          } else if (resource === "workspaces" && action === "mount") await api.mountWorkspace(id);
          else if (resource === "workspaces" && action === "unmount") await api.unmountWorkspace(id);
          else throw new HttpError(404, "Unknown action.");
        } else throw new HttpError(404, "Unknown action.");
      }
      send(res, 200, api.state());
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof Error && error.name === "ZodError" ? 400 : 409;
      send(res, status, { error: error instanceof Error ? error.message : "Operation failed." });
    }
  };
}

// src/index.ts
var name = "ssh-workspaces";
var inject = ["webServer", "connection", "workspaceRegistry", "subprocess", "sandbox", "sandboxPolicy", "fs"];
var Config = schema.object({
  stateDir: schema.string().default(join4(homedir2(), ".dsh", "ssh-workspaces")),
  mountRoot: schema.string().default(join4(homedir2(), ".dsh", "ssh-workspaces", "mounts")),
  requestTimeoutMs: schema.number().min(1e3).max(6e5).step(1).default(3e4),
  mountTimeoutMs: schema.number().min(1e3).max(12e4).step(1).default(2e4),
  sshfsBinary: schema.string().default("sshfs"),
  helperInstallTimeoutMs: schema.number().min(3e4).max(36e5).step(1).default(6e5)
});
async function apply(ctx, config) {
  if (!isAbsolute3(config.stateDir) || !isAbsolute3(config.mountRoot)) throw new Error("SSH stateDir and mountRoot must be absolute paths.");
  const connection = Reflect.get(ctx, "connection");
  if (typeof connection?.requestRejection !== "function") throw new Error("Unsupported DSH connection API: requestRejection is required.");
  const manager = new SshWorkspaceManager(ctx, config);
  ctx.effect(() => () => manager.dispose());
  await manager.ready;
  installRouting(ctx, manager);
  installFsRouting(ctx, manager);
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PATH,
    handler: managementHandler(manager, (request) => connection.requestRejection(request))
  }));
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
