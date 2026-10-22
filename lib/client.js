window.__ModuleLoader__.load({id:"dsh-ssh-workspaces",factory:(require)=>{var module={exports:{}};var exports=module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "ssh-workspaces";
var PANEL_ID = "ssh-workspaces";
var zh = {
  panel: "SSH \u5DE5\u4F5C\u533A",
  subtitle: "\u5728\u8FDC\u7A0B\u670D\u52A1\u5668\u4E0A\u5F00\u53D1\uFF0C\u6CBF\u7528\u5F53\u524D Host \u7684\u6A21\u578B\u3001\u63D2\u4EF6\u4E0E Skills\u3002",
  servers: "SSH \u670D\u52A1\u5668",
  workspaces: "\u8FDC\u7A0B\u5DE5\u4F5C\u533A",
  conversations: "\u5DE5\u4F5C\u533A\u5BF9\u8BDD",
  refresh: "\u5237\u65B0",
  loading: "\u52A0\u8F7D\u4E2D\u2026",
  working: "\u5904\u7406\u4E2D\u2026",
  saved: "\u5DF2\u5B8C\u6210",
  close: "\u5173\u95ED",
  addServer: "\u6DFB\u52A0\u670D\u52A1\u5668",
  editServer: "\u7F16\u8F91\u670D\u52A1\u5668",
  label: "\u663E\u793A\u540D\u79F0",
  host: "SSH Host \u522B\u540D",
  fromConfig: "\u4ECE ~/.ssh/config \u9009\u62E9",
  configPlaceholder: "\u9009\u62E9 Host \u4E0A\u5DF2\u914D\u7F6E\u7684\u670D\u52A1\u5668\u2026",
  configEmpty: "\u672A\u627E\u5230\u5177\u4F53 Host \u522B\u540D\uFF0C\u53EF\u5728\u4E0B\u65B9\u76F4\u63A5\u586B\u5199\u3002",
  configHelp: "\u8BFB\u53D6\u8FD0\u884C DSH \u7684 Host \u914D\u7F6E\u53CA Include \u6587\u4EF6\uFF1B\u8FDE\u63A5\u6CBF\u7528 OpenSSH \u7684\u5BC6\u94A5\u3001\u7AEF\u53E3\u548C\u8DF3\u677F\u673A\u8BBE\u7F6E\u3002",
  helperMode: "Helper \u5B89\u88C5",
  autoHelper: "\u81EA\u52A8\u5B89\u88C5\uFF08\u63A8\u8350\uFF09",
  manualHelper: "\u624B\u52A8\u6307\u5B9A\uFF08\u9AD8\u7EA7\uFF09",
  autoHelp: "\u9996\u6B21\u8FDE\u63A5\u65F6\u81EA\u52A8\u5B89\u88C5\u5339\u914D\u7248\u672C\u7684 Helper \u548C Node\uFF0C\u8FDC\u7AEF\u65E0\u9700\u8054\u7F51\u3002\u53EF\u5173\u95ED\u672C\u9762\u677F\uFF0C\u5B89\u88C5\u4F1A\u5728\u540E\u53F0\u7EE7\u7EED\u3002",
  installing: "\u5B89\u88C5\u4E2D",
  detecting: "\u68C0\u6D4B\u8FDC\u7A0B\u5E73\u53F0\u2026",
  preparing: "Host \u6B63\u5728\u51C6\u5907\u8FD0\u884C\u5305\u2026",
  uploading: "\u7ECF SSH \u4E0A\u4F20\u5E76\u5B89\u88C5\u2026",
  verifying: "\u6821\u9A8C\u8FDC\u7A0B\u8FD0\u884C\u5305\u2026",
  connectionStarted: "\u8FDE\u63A5\u4EFB\u52A1\u5DF2\u542F\u52A8\uFF0C\u8FDB\u5EA6\u89C1\u670D\u52A1\u5668\u72B6\u6001\u3002",
  hostHelp: "\u4F7F\u7528 Host \u4E0A\u5DF2\u914D\u7F6E\u7684 OpenSSH \u522B\u540D\u3001\u5BC6\u94A5\u53CA known_hosts\uFF1B\u6D4F\u89C8\u5668\u4E0D\u63A5\u6536\u79C1\u94A5\u3002",
  helper: "\u8FDC\u7A0B Helper \u7EDD\u5BF9\u8DEF\u5F84",
  helperHash: "Helper SHA-256",
  launch: "Helper \u542F\u52A8\u65B9\u5F0F",
  executable: "\u72EC\u7ACB\u53EF\u6267\u884C\u6587\u4EF6",
  nodeScript: "Node.js \u811A\u672C",
  node: "\u8FDC\u7A0B Node.js \u7EDD\u5BF9\u8DEF\u5F84",
  advanced: "\u9AD8\u7EA7\u9009\u9879",
  tunnels: "\u53CD\u5411\u96A7\u9053\uFF08JSON \u6570\u7EC4\uFF09",
  executableMap: "\u7A0B\u5E8F\u8DEF\u5F84\u6620\u5C04\uFF08JSON \u5BF9\u8C61\uFF09",
  hostExecutables: "\u56FA\u5B9A\u5728 Host \u6267\u884C\u7684\u7A0B\u5E8F\uFF08JSON \u6570\u7EC4\uFF09",
  hostExecutablesHelp: "\u53EA\u586B\u5199\u786E\u5B9E\u5E94\u7559\u5728 Host \u7684\u7A0B\u5E8F\u8DEF\u5F84\uFF1B\u5176\u4F59\u5DE5\u4F5C\u533A\u547D\u4EE4\u8F6C\u5230\u8FDC\u7A0B\u6267\u884C\u3002",
  bootstrapPath: "PTC Bootstrap \u7EDD\u5BF9\u8DEF\u5F84\uFF08\u53EF\u9009\uFF09",
  bootstrapHash: "PTC Bootstrap SHA-256\uFF08\u53EF\u9009\uFF09",
  validationBootstrap: "Bootstrap \u8DEF\u5F84\u4E0E SHA-256 \u5FC5\u987B\u540C\u65F6\u586B\u5199\u3002",
  validationHostExecutables: "Host \u7A0B\u5E8F\u987B\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32\u7EC4\u6210\u7684 JSON \u6570\u7EC4\u3002",
  tunnelsHelp: "\u8FDC\u7A0B 127.0.0.1:remotePort \u2192 Host \u7684 host:port\u3002\u6A21\u578B\u8BF7\u6C42\u9ED8\u8BA4\u7531 Host \u76F4\u63A5\u53D1\u9001\uFF0C\u65E0\u9700\u96A7\u9053\u3002",
  mapHelp: '\u4F8B\u5982 {"/usr/bin/bash":"/bin/bash"}\uFF0C\u5C06 Host \u7684\u7A0B\u5E8F\u8DEF\u5F84\u6620\u5C04\u5230\u8FDC\u7A0B\u7A0B\u5E8F\u8DEF\u5F84\u3002',
  save: "\u4FDD\u5B58",
  cancel: "\u53D6\u6D88",
  edit: "\u7F16\u8F91",
  remove: "\u5220\u9664",
  connect: "\u8FDE\u63A5",
  disconnect: "\u65AD\u5F00",
  probe: "\u68C0\u67E5\u8FDE\u63A5",
  noServers: "\u6DFB\u52A0\u7B2C\u4E00\u53F0\u670D\u52A1\u5668\uFF0C\u7136\u540E\u8FDE\u63A5\u5E76\u6DFB\u52A0\u8FDC\u7A0B\u76EE\u5F55\u3002",
  noWorkspaces: "\u6B64\u670D\u52A1\u5668\u8FD8\u6CA1\u6709\u5DE5\u4F5C\u533A\u3002",
  noSessions: "\u6B64\u5DE5\u4F5C\u533A\u8FD8\u6CA1\u6709\u5BF9\u8BDD\u3002",
  selectServer: "\u9009\u62E9\u670D\u52A1\u5668",
  selectedServer: "\u5F53\u524D\u670D\u52A1\u5668",
  remotePath: "\u8FDC\u7A0B\u76EE\u5F55\u7EDD\u5BF9\u8DEF\u5F84",
  title: "\u5DE5\u4F5C\u533A\u540D\u79F0",
  addWorkspace: "\u6DFB\u52A0\u5DE5\u4F5C\u533A",
  mount: "\u6302\u8F7D",
  unmount: "\u5378\u8F7D",
  open: "\u6253\u5F00",
  newSession: "\u65B0\u5EFA\u5BF9\u8BDD",
  viewSessions: "\u67E5\u770B\u5BF9\u8BDD",
  archive: "\u5F52\u6863",
  restore: "\u6062\u590D",
  showArchived: "\u663E\u793A\u5DF2\u5F52\u6863",
  running: "\u8FD0\u884C\u4E2D",
  disconnectConfirm: "\u65AD\u5F00\u670D\u52A1\u5668\u5C06\u5F71\u54CD\u8BE5\u670D\u52A1\u5668\u4E0A\u7684\u5DE5\u4F5C\u533A\u548C\u8FD0\u884C\u4E2D\u7684\u547D\u4EE4\uFF0C\u662F\u5426\u7EE7\u7EED\uFF1F",
  unmountConfirm: "\u5378\u8F7D\u5DE5\u4F5C\u533A\u524D\u8BF7\u505C\u6B62\u4F7F\u7528\u5B83\u7684\u547D\u4EE4\u548C\u7F16\u8F91\u5668\u3002\u662F\u5426\u7EE7\u7EED\uFF1F",
  deleteServerConfirm: "\u5220\u9664\u6B64\u670D\u52A1\u5668\u914D\u7F6E\uFF1F\u8BF7\u5148\u79FB\u9664\u5176\u5DE5\u4F5C\u533A\u3002\u4E0D\u4F1A\u5220\u9664\u8FDC\u7A0B\u6587\u4EF6\u3002",
  deleteWorkspaceConfirm: "\u79FB\u9664\u6B64\u5DE5\u4F5C\u533A\u6CE8\u518C\uFF1F\u4E0D\u4F1A\u5220\u9664\u8FDC\u7A0B\u6587\u4EF6\u6216\u5DF2\u4FDD\u5B58\u7684\u5BF9\u8BDD\u3002",
  connected: "\u5DF2\u8FDE\u63A5",
  disconnected: "\u672A\u8FDE\u63A5",
  connecting: "\u8FDE\u63A5\u4E2D",
  mounted: "\u5DF2\u6302\u8F7D",
  unmounted: "\u672A\u6302\u8F7D",
  mounting: "\u6302\u8F7D\u4E2D",
  error: "\u9519\u8BEF",
  ready: "\u5C31\u7EEA",
  idle: "\u7A7A\u95F2",
  unknown: "\u672A\u77E5",
  validationAlias: "SSH \u522B\u540D\u53EA\u80FD\u5305\u542B\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u70B9\u3001\u4E0B\u5212\u7EBF\u3001@ \u548C\u8FDE\u5B57\u7B26\uFF0C\u4E14\u4E0D\u80FD\u4EE5\u8FDE\u5B57\u7B26\u5F00\u5934\u3002",
  validationPath: "\u8BF7\u586B\u5199\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u4E0D\u80FD\u5305\u542B\u6362\u884C\u6216 NUL\u3002",
  validationHash: "SHA-256 \u5FC5\u987B\u4E3A 64 \u4F4D\u5341\u516D\u8FDB\u5236\u5B57\u7B26\u4E32\u3002",
  validationTunnels: "\u96A7\u9053\u987B\u4E3A\u6570\u7EC4\uFF0C\u5404\u9879\u5305\u542B\u6709\u6548\u7684 remotePort\u3001host\u3001port\u3002",
  validationMap: "\u7A0B\u5E8F\u6620\u5C04\u987B\u4E3A JSON \u5BF9\u8C61\uFF0C\u952E\u548C\u503C\u5747\u4E3A\u975E\u7A7A\u5B57\u7B26\u4E32\u3002",
  requestFailed: "\u8BF7\u6C42\u5931\u8D25",
  invalidResponse: "\u670D\u52A1\u5668\u8FD4\u56DE\u4E86\u65E0\u6548\u54CD\u5E94\u3002",
  mountRequired: "\u8BF7\u5148\u8FDE\u63A5\u670D\u52A1\u5668\u5E76\u6302\u8F7D\u5DE5\u4F5C\u533A\u3002",
  nativePending: "\u7B49\u5F85 DSH \u540C\u6B65\u5DE5\u4F5C\u533A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
  authError: "DSH \u767B\u5F55\u5DF2\u5931\u6548\u6216\u8BF7\u6C42\u88AB\u62D2\u7EDD\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u5E76\u91CD\u65B0\u767B\u5F55\u3002",
  selectedWorkspace: "\u5F53\u524D\u5DE5\u4F5C\u533A",
  mountPath: "Host \u6302\u8F7D\u8DEF\u5F84",
  closeEditor: "\u5173\u95ED\u7F16\u8F91\u5668",
  serverCount: "\u53F0\u670D\u52A1\u5668",
  workspaceCount: "\u4E2A\u5DE5\u4F5C\u533A",
  helperHelp: "\u4EC5\u7528\u4E8E\u63A5\u7BA1\u5DF2\u6709 Helper\uFF1B\u65B0\u670D\u52A1\u5668\u4FDD\u6301\u9ED8\u8BA4\u7684\u81EA\u52A8\u5B89\u88C5\u5373\u53EF\u3002",
  status: "\u72B6\u6001",
  inspectDetails: "\u8BE6\u7EC6\u4FE1\u606F",
  noSelection: "\u9009\u62E9\u4E00\u4E2A\u5DE5\u4F5C\u533A\u4EE5\u67E5\u770B\u5BF9\u8BDD\u3002"
};
var en = {
  panel: "SSH Workspaces",
  subtitle: "Develop on remote servers with this Host\u2019s models, plugins and skills.",
  servers: "SSH servers",
  workspaces: "Remote workspaces",
  conversations: "Workspace conversations",
  refresh: "Refresh",
  loading: "Loading\u2026",
  working: "Working\u2026",
  saved: "Done",
  close: "Close",
  addServer: "Add server",
  editServer: "Edit server",
  label: "Display name",
  host: "SSH Host alias",
  fromConfig: "Choose from ~/.ssh/config",
  configPlaceholder: "Select a configured SSH server\u2026",
  configEmpty: "No concrete Host aliases found. Enter an alias below.",
  configHelp: "Reads the DSH Host\u2019s config and Include files. OpenSSH retains keys, ports and jump hosts.",
  helperMode: "Helper installation",
  autoHelper: "Automatic (recommended)",
  manualHelper: "Manual (advanced)",
  autoHelp: "First connection installs a matching Helper and Node automatically. The remote needs no internet. Setup continues if you close this panel.",
  installing: "Installing",
  detecting: "Detecting remote platform\u2026",
  preparing: "Preparing runtime on Host\u2026",
  uploading: "Uploading and installing over SSH\u2026",
  verifying: "Verifying remote runtime\u2026",
  connectionStarted: "Connection started. Follow progress in the server status.",
  hostHelp: "Uses the Host\u2019s existing OpenSSH alias, keys and known_hosts. Private keys never enter the browser.",
  helper: "Remote Helper absolute path",
  helperHash: "Helper SHA-256",
  launch: "Helper launch mode",
  executable: "Standalone executable",
  nodeScript: "Node.js script",
  node: "Remote Node.js absolute path",
  advanced: "Advanced options",
  tunnels: "Reverse tunnels (JSON array)",
  executableMap: "Executable paths (JSON object)",
  hostExecutables: "Host-only executables (JSON array)",
  hostExecutablesHelp: "Only list programs that must remain on the Host; other workspace commands execute remotely.",
  bootstrapPath: "PTC Bootstrap absolute path (optional)",
  bootstrapHash: "PTC Bootstrap SHA-256 (optional)",
  validationBootstrap: "Bootstrap path and SHA-256 must be supplied together.",
  validationHostExecutables: "Host executables must be a JSON array of nonempty strings.",
  tunnelsHelp: "Remote 127.0.0.1:remotePort \u2192 Host host:port. Model requests already run on the Host and need no tunnel.",
  mapHelp: 'For example {"/usr/bin/bash":"/bin/bash"} maps a Host executable path to its remote executable.',
  save: "Save",
  cancel: "Cancel",
  edit: "Edit",
  remove: "Delete",
  connect: "Connect",
  disconnect: "Disconnect",
  probe: "Probe connection",
  noServers: "Add your first server, connect, then add a remote directory.",
  noWorkspaces: "This server has no workspaces yet.",
  noSessions: "This workspace has no conversations yet.",
  selectServer: "Select server",
  selectedServer: "Selected server",
  remotePath: "Remote directory absolute path",
  title: "Workspace name",
  addWorkspace: "Add workspace",
  mount: "Mount",
  unmount: "Unmount",
  open: "Open",
  newSession: "New conversation",
  viewSessions: "Conversations",
  archive: "Archive",
  restore: "Restore",
  showArchived: "Show archived",
  running: "Running",
  disconnectConfirm: "Disconnecting affects this server\u2019s workspaces and running commands. Continue?",
  unmountConfirm: "Stop commands and editors using this workspace before unmounting. Continue?",
  deleteServerConfirm: "Delete this server configuration? Remove its workspaces first. Remote files are kept.",
  deleteWorkspaceConfirm: "Remove this workspace registration? Remote files and saved conversations are kept.",
  connected: "Connected",
  disconnected: "Disconnected",
  connecting: "Connecting",
  mounted: "Mounted",
  unmounted: "Unmounted",
  mounting: "Mounting",
  error: "Error",
  ready: "Ready",
  idle: "Idle",
  unknown: "Unknown",
  validationAlias: "SSH aliases may contain letters, numbers, dots, underscores, @ and hyphens, and cannot start with a hyphen.",
  validationPath: "Enter an absolute path without newlines or NUL.",
  validationHash: "SHA-256 must contain 64 hexadecimal characters.",
  validationTunnels: "Tunnels must be an array of objects with valid remotePort, host and port.",
  validationMap: "Executable mapping must be a JSON object with nonempty string keys and values.",
  requestFailed: "Request failed",
  invalidResponse: "The server returned an invalid response.",
  mountRequired: "Connect the server and mount this workspace first.",
  nativePending: "Waiting for DSH workspace synchronization. Try again shortly.",
  authError: "DSH authentication expired or the request was rejected. Refresh the page and sign in again.",
  selectedWorkspace: "Selected workspace",
  mountPath: "Host mount path",
  closeEditor: "Close editor",
  serverCount: "servers",
  workspaceCount: "workspaces",
  helperHelp: "Only for an existing Helper. New servers can use automatic installation.",
  status: "Status",
  inspectDetails: "Details",
  noSelection: "Choose a workspace to view its conversations."
};
async function request(t, path, method = "GET", body, signal) {
  const base = new URL("api/ssh-workspaces", document.baseURI);
  const response = await fetch(`${base.href}${path}`, {
    method,
    credentials: "same-origin",
    signal,
    headers: { accept: "application/json", ...body === void 0 ? {} : { "content-type": "application/json" } },
    ...body === void 0 ? {} : { body: JSON.stringify(body) }
  });
  if (response.status === 401 || response.status === 403) throw new Error(t("authError"));
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${t("invalidResponse")} HTTP ${response.status}`);
  }
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.message === "string" ? payload.message : isRecord(payload) && typeof payload.error === "string" ? payload.error : response.statusText;
    throw new Error(`${t("requestFailed")} (${response.status}): ${detail}`);
  }
  return payload;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readState(value, t) {
  if (!isRecord(value) || !Array.isArray(value.servers) || !Array.isArray(value.workspaces)) throw new Error(t("invalidResponse"));
  const servers = value.servers.map((row) => {
    if (!isRecord(row) || !["id", "label", "host", "status"].every((k) => typeof row[k] === "string") || row.launch !== void 0 && (!isRecord(row.launch) || !["executable", "node-script"].includes(String(row.launch.kind)) || row.launch.kind === "node-script" && typeof row.launch.node !== "string")) throw new Error(t("invalidResponse"));
    return row;
  });
  const workspaces = value.workspaces.map((row) => {
    if (!isRecord(row) || !["id", "serverId", "remotePath", "mountPath", "title", "status"].every((k) => typeof row[k] === "string") || row.workspaceId !== void 0 && typeof row.workspaceId !== "string") throw new Error(t("invalidResponse"));
    return row;
  });
  return { servers, workspaces };
}
var s = {
  page: { padding: "28px clamp(16px, 3vw, 40px)", height: "100%", overflow: "auto", boxSizing: "border-box", color: "var(--text-primary, #253248)", background: "var(--bg-primary, #f8fafc)" },
  header: { display: "flex", alignItems: "start", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 22 },
  h1: { margin: "0 0 8px", fontSize: 25, fontWeight: 650, letterSpacing: "-.5px" },
  muted: { color: "var(--text-secondary, #64748b)", fontSize: 13, lineHeight: 1.6, margin: "4px 0" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 22, alignItems: "start" },
  card: { background: "var(--bg-secondary, #fff)", border: "1px solid var(--border-color, #e2e8f0)", borderRadius: 14, padding: 20, minWidth: 0 },
  row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
  buttons: { display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" },
  button: { border: "1px solid var(--border-color, #d7dfe8)", borderRadius: 8, padding: "7px 11px", color: "inherit", background: "var(--bg-primary, #f8fafc)", cursor: "pointer", fontSize: 13 },
  primary: { border: "1px solid #315ed7", borderRadius: 8, padding: "8px 13px", color: "#fff", background: "#315ed7", cursor: "pointer", fontSize: 13 },
  input: { width: "100%", boxSizing: "border-box", padding: "9px 11px", fontSize: 13, border: "1px solid var(--border-color, #d7dfe8)", borderRadius: 8, color: "inherit", background: "var(--bg-primary, #f8fafc)" },
  label: { display: "block", fontSize: 13, fontWeight: 550, marginBottom: 6 },
  field: { marginTop: 14 },
  item: { border: "1px solid var(--border-color, #e2e8f0)", borderRadius: 10, padding: 13, marginTop: 12 },
  code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, overflowWrap: "anywhere", margin: "7px 0", color: "var(--text-secondary, #64748b)" },
  error: { padding: "11px 14px", border: "1px solid #f1b7b7", borderRadius: 9, background: "#fff1f1", color: "#9f2424", marginBottom: 16, overflowWrap: "anywhere", fontSize: 13 },
  notice: { padding: "10px 14px", borderRadius: 9, background: "#edf6f1", color: "#246845", marginBottom: 16, fontSize: 13 },
  section: { fontSize: 16, margin: 0, fontWeight: 650 },
  badge: { padding: "3px 8px", borderRadius: 20, background: "var(--bg-primary, #f1f5f9)", color: "var(--text-secondary, #64748b)", fontSize: 11, whiteSpace: "nowrap" }
};
function Button({ children, primary = false, ...props }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", ...props, style: { ...primary ? s.primary : s.button, opacity: props.disabled ? 0.5 : 1, ...props.style }, children });
}
function Field({ label, children, hint }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.field, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: s.label, children: [
      label,
      children
    ] }),
    hint && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: s.muted, children: hint })
  ] });
}
function Badge({ status, t }) {
  const known = ["connected", "disconnected", "connecting", "installing", "mounted", "unmounted", "mounting", "error", "ready", "idle"];
  const key = known.find((k) => k === status);
  const healthy = status === "connected" || status === "mounted" || status === "ready";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...s.badge, ...healthy ? { color: "#19704b", background: "#e5f4ec" } : {} }, children: key ? t(key) : status || t("unknown") });
}
function ServerEditor({ server, t, busy, save, close }) {
  const [label, setLabel] = (0, import_react.useState)(server?.label ?? "");
  const [host, setHost] = (0, import_react.useState)(server?.host ?? "");
  const [helperMode, setHelperMode] = (0, import_react.useState)(server?.helperMode ?? (server?.helper ? "manual" : "auto"));
  const [configHosts, setConfigHosts] = (0, import_react.useState)([]);
  const [configNotice, setConfigNotice] = (0, import_react.useState)("");
  const [configLoading, setConfigLoading] = (0, import_react.useState)(true);
  (0, import_react.useEffect)(() => {
    const controller = new AbortController();
    void request(t, "/ssh-config", "GET", void 0, controller.signal).then((value) => {
      if (!isRecord(value) || !Array.isArray(value.hosts) || !Array.isArray(value.warnings) || !value.hosts.every((row) => isRecord(row) && typeof row.host === "string" && typeof row.source === "string")) throw new Error(t("invalidResponse"));
      setConfigHosts(value.hosts);
      setConfigNotice(value.warnings.map(String).join(" \xB7 "));
    }).catch((reason) => {
      if (!controller.signal.aborted) setConfigNotice(String(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setConfigLoading(false);
    });
    return () => controller.abort();
  }, [t]);
  const [helper, setHelper] = (0, import_react.useState)(server?.helper ?? "");
  const [hash, setHash] = (0, import_react.useState)(server?.helperHash ?? "");
  const [kind, setKind] = (0, import_react.useState)(server?.launch?.kind ?? "executable");
  const [node, setNode] = (0, import_react.useState)(server?.launch?.kind === "node-script" ? server.launch.node : "/usr/bin/node");
  const [bootstrapPath, setBootstrapPath] = (0, import_react.useState)(server?.launch?.kind === "node-script" ? server.launch.bootstrapPath ?? "" : "");
  const [bootstrapHash, setBootstrapHash] = (0, import_react.useState)(server?.launch?.kind === "node-script" ? server.launch.bootstrapHash ?? "" : "");
  const [tunnels, setTunnels] = (0, import_react.useState)(JSON.stringify(server?.tunnels ?? [], null, 2));
  const [map, setMap] = (0, import_react.useState)(JSON.stringify(server?.executableMap ?? {}, null, 2));
  const [hostExecutables, setHostExecutables] = (0, import_react.useState)(JSON.stringify(server?.hostExecutables ?? [], null, 2));
  const [error, setError] = (0, import_react.useState)("");
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host.trim())) throw new Error(t("validationAlias"));
      const absolute = (path) => path.startsWith("/") && !/[\r\n\0]/.test(path);
      if (helperMode === "manual" && (!absolute(helper.trim()) || kind === "node-script" && !absolute(node.trim()))) throw new Error(t("validationPath"));
      if (helperMode === "manual" && !/^[a-fA-F0-9]{64}$/.test(hash.trim())) throw new Error(t("validationHash"));
      const parsedTunnels = JSON.parse(tunnels);
      const port = (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
      if (!Array.isArray(parsedTunnels) || !parsedTunnels.every((item) => isRecord(item) && port(item.remotePort) && Number(item.remotePort) >= 1024 && typeof item.host === "string" && ["127.0.0.1", "localhost", "::1"].includes(item.host) && port(item.port))) throw new Error(t("validationTunnels"));
      const parsedMap = JSON.parse(map);
      if (!isRecord(parsedMap) || !Object.entries(parsedMap).every(([k, v]) => k.length > 0 && typeof v === "string" && v.length > 0)) throw new Error(t("validationMap"));
      const parsedHostExecutables = JSON.parse(hostExecutables);
      if (!Array.isArray(parsedHostExecutables) || !parsedHostExecutables.every((value) => typeof value === "string" && value.length > 0)) throw new Error(t("validationHostExecutables"));
      if (helperMode === "manual" && kind === "node-script" && Boolean(bootstrapPath.trim()) !== Boolean(bootstrapHash.trim())) throw new Error(t("validationBootstrap"));
      if (helperMode === "manual" && kind === "node-script" && bootstrapPath.trim() && (!absolute(bootstrapPath.trim()) || !/^[a-fA-F0-9]{64}$/.test(bootstrapHash.trim()))) throw new Error(t("validationBootstrap"));
      await save({
        ...server === void 0 ? {} : { id: server.id },
        label: label.trim() || host.trim(),
        host: host.trim(),
        helperMode,
        ...helperMode === "auto" ? {} : {
          helper: helper.trim(),
          helperHash: hash.trim().toLowerCase(),
          launch: kind === "executable" ? { kind } : {
            kind,
            node: node.trim(),
            ...bootstrapPath.trim() ? { bootstrapPath: bootstrapPath.trim(), bootstrapHash: bootstrapHash.trim().toLowerCase() } : {}
          }
        },
        tunnels: parsedTunnels,
        executableMap: parsedMap,
        hostExecutables: parsedHostExecutables
      });
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { onSubmit: (event) => {
    void submit(event);
  }, style: { ...s.item, borderColor: "#8aa7f0" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: s.section, children: t(server ? "editServer" : "addServer") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { onClick: close, "aria-label": t("closeEditor"), disabled: busy, children: "\xD7" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("fromConfig"), hint: t("configHelp"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        style: s.input,
        value: configHosts.some((item) => item.host === host) ? host : "",
        disabled: configLoading || busy,
        onChange: (event) => {
          const alias = event.target.value;
          setHost(alias);
          if (!label) setLabel(alias);
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: t(configLoading ? "loading" : "configPlaceholder") }),
          configHosts.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: item.host, children: item.host }, item.host))
        ]
      }
    ) }),
    !configLoading && configHosts.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.muted, children: t("configEmpty") }),
    configNotice && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", style: s.muted, children: configNotice }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("label"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, value: label, onChange: (e) => setLabel(e.target.value) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("host"), hint: t("hostHelp"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, value: host, onChange: (e) => setHost(e.target.value), required: true, placeholder: "gpu-server" }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("helperMode"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { style: s.input, value: helperMode, onChange: (event) => setHelperMode(event.target.value === "manual" ? "manual" : "auto"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "auto", children: t("autoHelper") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "manual", children: t("manualHelper") })
    ] }) }),
    helperMode === "auto" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.muted, children: t("autoHelp") }),
    helperMode === "manual" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("helper"), hint: t("helperHelp"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, value: helper, onChange: (e) => setHelper(e.target.value), required: true, placeholder: "/opt/dsh-ssh/helper" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("helperHash"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...s.input, fontFamily: "monospace" }, value: hash, onChange: (e) => setHash(e.target.value), required: true, minLength: 64, maxLength: 64, spellCheck: false }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("launch"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { style: s.input, value: kind, onChange: (e) => setKind(e.target.value === "node-script" ? "node-script" : "executable"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "executable", children: t("executable") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "node-script", children: t("nodeScript") })
      ] }) }),
      kind === "node-script" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("node"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, value: node, onChange: (e) => setNode(e.target.value), required: true }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: s.field, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { style: { cursor: "pointer", fontSize: 13 }, children: t("advanced") }),
      helperMode === "manual" && kind === "node-script" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("bootstrapPath"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, value: bootstrapPath, onChange: (event) => setBootstrapPath(event.target.value) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("bootstrapHash"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...s.input, fontFamily: "monospace" }, value: bootstrapHash, onChange: (event) => setBootstrapHash(event.target.value), spellCheck: false }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("tunnels"), hint: t("tunnelsHelp"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { style: { ...s.input, minHeight: 90, fontFamily: "monospace" }, value: tunnels, onChange: (e) => setTunnels(e.target.value), spellCheck: false }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("executableMap"), hint: t("mapHelp"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { style: { ...s.input, minHeight: 75, fontFamily: "monospace" }, value: map, onChange: (e) => setMap(e.target.value), spellCheck: false }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("hostExecutables"), hint: t("hostExecutablesHelp"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { style: { ...s.input, minHeight: 70, fontFamily: "monospace" }, value: hostExecutables, onChange: (event) => setHostExecutables(event.target.value), spellCheck: false }) })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", style: { ...s.error, marginTop: 12 }, children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...s.buttons, marginTop: 16 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { type: "submit", primary: true, disabled: busy, children: t(busy ? "working" : "save") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { onClick: close, disabled: busy, children: t("cancel") })
    ] })
  ] });
}
function Page(props) {
  const { t } = props;
  const [state, setState] = (0, import_react.useState)({ servers: [], workspaces: [] });
  const [loaded, setLoaded] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)("");
  const [notice, setNotice] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [selectedServer, setSelectedServer] = (0, import_react.useState)("");
  const [selectedWorkspace, setSelectedWorkspace] = (0, import_react.useState)("");
  const [editor, setEditor] = (0, import_react.useState)(null);
  const [remotePath, setRemotePath] = (0, import_react.useState)("");
  const [title, setTitle] = (0, import_react.useState)("");
  const [showArchived, setShowArchived] = (0, import_react.useState)(false);
  const lifetime = (0, import_react.useRef)(void 0);
  const requestNumber = (0, import_react.useRef)(0);
  const busyRef = (0, import_react.useRef)(false);
  const subscribeWorkspaces = (0, import_react.useCallback)((listener) => props.workspaces.list.subscribe(listener), [props.workspaces]);
  const readWorkspaces = (0, import_react.useCallback)(() => props.workspaces.list.getSnapshot(), [props.workspaces]);
  const subscribeSessions = (0, import_react.useCallback)((listener) => props.sessions.list.subscribe(listener), [props.sessions]);
  const readSessions = (0, import_react.useCallback)(() => props.sessions.list.getSnapshot(), [props.sessions]);
  const nativeWorkspaces = (0, import_react.useSyncExternalStore)(subscribeWorkspaces, readWorkspaces);
  const nativeSessions = (0, import_react.useSyncExternalStore)(subscribeSessions, readSessions);
  const refresh = (0, import_react.useCallback)(async () => {
    const sequence = ++requestNumber.current;
    const result = readState(await request(t, "", "GET", void 0, lifetime.current?.signal), t);
    if (sequence === requestNumber.current && !lifetime.current?.signal.aborted) {
      setState(result);
      setLoaded(true);
    }
  }, [t]);
  (0, import_react.useEffect)(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    void refresh().catch((reason) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch((reason) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 4e3);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [refresh]);
  (0, import_react.useEffect)(() => {
    if (!state.servers.some((server) => server.id === selectedServer)) setSelectedServer(state.servers[0]?.id ?? "");
    if (!state.workspaces.some((workspace) => workspace.id === selectedWorkspace)) setSelectedWorkspace("");
  }, [state, selectedServer, selectedWorkspace]);
  const run = async (operation, rethrow = false) => {
    if (busyRef.current) {
      if (rethrow) throw new Error(t("working"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (reason) {
      if (!lifetime.current?.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      if (rethrow) throw reason;
    } finally {
      busyRef.current = false;
      if (!lifetime.current?.signal.aborted) setBusy(false);
    }
  };
  const mutate = async (path, method = "POST", body) => {
    await request(t, path, method, body, lifetime.current?.signal);
    await refresh();
    setNotice(t(path.endsWith("/connect") ? "connectionStarted" : "saved"));
  };
  const act = (path, method = "POST", body) => {
    void run(() => mutate(path, method, body));
  };
  const activeServer = state.servers.find((server) => server.id === selectedServer);
  const visibleWorkspaces = state.workspaces.filter((workspace) => workspace.serverId === selectedServer);
  const selected = state.workspaces.find((workspace) => workspace.id === selectedWorkspace);
  const native = nativeWorkspaces.items.find((workspace) => workspace.workspaceId === selected?.workspaceId);
  const conversationIds = native?.sessionIds ?? [];
  const ids = conversationIds.filter((id) => showArchived || !nativeWorkspaces.archivedSessionIds.includes(id));
  const isReady = (workspace) => workspace.status === "mounted" && workspace.workspaceId !== void 0;
  const open = (workspace, fresh = false) => {
    void run(async () => {
      if (!isReady(workspace) || workspace.workspaceId === void 0) throw new Error(t("mountRequired"));
      if (!nativeWorkspaces.items.some((item) => item.workspaceId === workspace.workspaceId)) throw new Error(t("nativePending"));
      if (fresh) props.newSession(workspace.workspaceId);
      else await props.openWorkspace(workspace.workspaceId);
    });
  };
  const addWorkspace = (event) => {
    event.preventDefault();
    if (!remotePath.startsWith("/") || /[\r\n\0]/.test(remotePath)) {
      setError(t("validationPath"));
      return;
    }
    void run(async () => {
      await mutate("/workspaces", "POST", { serverId: selectedServer, remotePath, title: title.trim() || remotePath.split("/").filter(Boolean).at(-1) || remotePath });
      setRemotePath("");
      setTitle("");
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.page, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.header, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", { style: s.h1, children: t("panel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.muted, children: t("subtitle") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.muted, children: [
          state.servers.length,
          " ",
          t("serverCount"),
          " \xB7 ",
          state.workspaces.length,
          " ",
          t("workspaceCount")
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { onClick: () => {
        void run(refresh);
      }, disabled: busy, children: t(busy ? "working" : "refresh") })
    ] }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "alert", style: s.error, children: error }),
    notice && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { role: "status", style: s.notice, children: notice }),
    !loaded && !error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.muted, children: t("loading") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.grid, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: s.card, "aria-label": t("servers"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: s.section, children: t("servers") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { primary: true, onClick: () => setEditor("new"), disabled: busy, children: t("addServer") })
        ] }),
        editor && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          ServerEditor,
          {
            server: editor === "new" ? void 0 : editor,
            t,
            busy,
            close: () => setEditor(null),
            save: (value) => run(() => mutate("/servers", "POST", value), true)
          },
          editor === "new" ? "new" : editor.id
        ),
        loaded && state.servers.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...s.muted, marginTop: 18 }, children: t("noServers") }),
        state.servers.map((server) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { style: { ...s.item, ...selectedServer === server.id ? { borderColor: "#86a4ee", boxShadow: "0 0 0 1px #86a4ee" } : {} }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                onClick: () => {
                  setSelectedServer(server.id);
                  setSelectedWorkspace("");
                },
                "aria-pressed": selectedServer === server.id,
                style: { border: 0, padding: 0, color: "inherit", font: "inherit", fontWeight: 650, background: "transparent", cursor: "pointer", textAlign: "left" },
                children: server.label
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { status: server.status, t })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.code, children: server.host }),
          server.setupPhase && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", "aria-live": "polite", style: s.muted, children: t(server.setupPhase) }),
          server.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", style: { ...s.muted, color: "#b43c3c" }, children: server.error }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.buttons, children: [
            server.status === "connected" || server.status === "ready" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy, onClick: () => act(`/servers/${encodeURIComponent(server.id)}/disconnect`), children: t("disconnect") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { primary: true, disabled: busy || ["connecting", "installing"].includes(server.status), onClick: () => act(`/servers/${encodeURIComponent(server.id)}/connect`), children: t("connect") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || ["connecting", "installing"].includes(server.status), onClick: () => {
              void run(async () => {
                const result = await request(t, `/servers/${encodeURIComponent(server.id)}/probe`, "POST", void 0, lifetime.current?.signal);
                if (!isRecord(result) || typeof result.message !== "string") throw new Error(t("invalidResponse"));
                if (result.ok === false) throw new Error(result.message);
                setNotice(result.message);
                await refresh();
              });
            }, children: t("probe") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || ["connecting", "installing", "connected"].includes(server.status), onClick: () => setEditor(server), children: t("edit") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || ["connecting", "installing"].includes(server.status), onClick: () => {
              if (window.confirm(t("deleteServerConfirm"))) act(`/servers/${encodeURIComponent(server.id)}`, "DELETE");
            }, children: t("remove") })
          ] })
        ] }, server.id))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: s.card, "aria-label": t("workspaces"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: s.section, children: t("workspaces") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("selectedServer"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { style: s.input, value: selectedServer, onChange: (event) => {
          setSelectedServer(event.target.value);
          setSelectedWorkspace("");
        }, children: [
          !selectedServer && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: t("selectServer") }),
          state.servers.map((server) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: server.id, children: [
            server.label,
            " (",
            server.host,
            ")"
          ] }, server.id))
        ] }) }),
        activeServer && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("form", { onSubmit: addWorkspace, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("remotePath"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, placeholder: "/data/projects/my-project", value: remotePath, onChange: (event) => setRemotePath(event.target.value), required: true }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("title"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: s.input, value: title, onChange: (event) => setTitle(event.target.value) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { type: "submit", primary: true, style: { marginTop: 14 }, disabled: busy || !selectedServer, children: t("addWorkspace") })
        ] }),
        activeServer && visibleWorkspaces.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...s.muted, marginTop: 16 }, children: t("noWorkspaces") }),
        visibleWorkspaces.map((workspace) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", { style: { ...s.item, ...selectedWorkspace === workspace.id ? { borderColor: "#86a4ee" } : {} }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: workspace.title }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { status: workspace.status, t })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: s.code, children: workspace.remotePath }),
          workspace.error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", style: { ...s.muted, color: "#b43c3c" }, children: workspace.error }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.buttons, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { primary: true, disabled: busy || !isReady(workspace), onClick: () => open(workspace), children: t("open") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || !isReady(workspace), onClick: () => open(workspace, true), children: t("newSession") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { onClick: () => setSelectedWorkspace(workspace.id), children: t("viewSessions") }),
            workspace.status === "mounted" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy, onClick: () => act(`/workspaces/${encodeURIComponent(workspace.id)}/unmount`), children: t("unmount") }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || workspace.status === "mounting", onClick: () => act(`/workspaces/${encodeURIComponent(workspace.id)}/mount`), children: t("mount") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy, onClick: () => {
              if (window.confirm(t("deleteWorkspaceConfirm"))) act(`/workspaces/${encodeURIComponent(workspace.id)}`, "DELETE");
            }, children: t("remove") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: { marginTop: 9, fontSize: 12 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { style: { cursor: "pointer", color: "var(--text-secondary, #64748b)" }, children: t("inspectDetails") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: s.code, children: [
              t("mountPath"),
              ": ",
              workspace.mountPath
            ] })
          ] })
        ] }, workspace.id))
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: { ...s.card, marginTop: 22 }, "aria-label": t("conversations"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: s.section, children: t("conversations") }),
          selected && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: s.muted, children: [
            selected.title,
            " \xB7 ",
            selected.remotePath
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { ...s.muted, display: "flex", gap: 7, alignItems: "center" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: showArchived, onChange: (event) => setShowArchived(event.target.checked) }),
          t("showArchived")
        ] })
      ] }),
      !selected ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...s.muted, marginTop: 16 }, children: t("noSelection") }) : ids.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...s.muted, marginTop: 16 }, children: t("noSessions") }) : ids.map((id) => {
        const session = nativeSessions.byId[id];
        const archived = nativeWorkspaces.archivedSessionIds.includes(id);
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...s.item, ...s.row }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { minWidth: 0 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 13 }, children: session?.displayTitle || id }),
            session?.running && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...s.badge, marginLeft: 8 }, children: t("running") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: s.code, children: id })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: s.buttons, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || archived, onClick: () => props.openSession(id), children: t("open") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { disabled: busy || Boolean(session?.running), onClick: () => {
              void run(() => archived ? props.restore(id) : props.archive(id));
            }, children: t(archived ? "restore" : "archive") })
          ] })
        ] }, id);
      })
    ] })
  ] });
}
function Icon({ size = 20 }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "3", y: "3", width: "18", height: "7", rx: "2" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "3", y: "14", width: "18", height: "7", rx: "2" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M7 6.5h.01M7 17.5h.01M12 10v4M16 6.5h2M16 17.5h2" })
  ] });
}
var inject = ["slots", "locale", "layout", "uiWorkspace", "workspaces", "sessions"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ssh-workspaces: locale");
  const t = ctx.locale.bind(NS);
  const face = {
    // Host and Client compile together in this external package; select the published Client face.
    workspaces: ctx.workspaces,
    sessions: Reflect.get(ctx, "sessions"),
    openWorkspace: (id) => ctx.uiWorkspace.openWorkspace(id),
    newSession: (id) => ctx.uiWorkspace.startSession(id),
    openSession: (id) => ctx.uiWorkspace.openSession(id),
    archive: (id) => ctx.uiWorkspace.archiveSession(id),
    restore: (id) => ctx.uiWorkspace.unarchiveSession(id)
  };
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: () => face }, Page));
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, locale: NS, label: () => t("panel") }, Icon));
}

return module.exports;}});
