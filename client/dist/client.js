window.__ModuleLoader__.load({
	id: "dsh-ssh-fleet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
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

// client/src/index.jsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// client/src/api.js
var PREFIX = "api/ssh-fleet.";
async function call(action, options = {}) {
  const { body, query, signal } = options;
  const search = query === void 0 ? "" : `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== void 0 && v !== ""))}`;
  const response = await fetch(`${PREFIX}${action}${search}`, {
    method: body === void 0 ? "GET" : "POST",
    credentials: "same-origin",
    signal,
    ...body === void 0 ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `request failed (${response.status})`);
  return payload;
}
var fleetApi = {
  hosts: () => call("hosts"),
  save: (host, create) => call("hosts.save", { body: { host, create } }),
  remove: (id) => call("hosts.remove", { body: { id } }),
  test: (host) => call("hosts.test", { body: { host } }),
  sshConfig: (path) => call("ssh-config", { query: { path } }),
  importSshConfig: (aliases, configPath) => call("ssh-config.import", { body: { aliases, configPath } }),
  listDirectory: (host, path, signal) => call("dir", { query: { host, path }, signal }),
  createDirectory: (host, path, name) => call("mkdir", { body: { host, path, name } }).then((r) => r.path),
  createWorkspace: (host, path) => call("workspace", { body: { host, path } })
};

// client/src/DirectoryFlow.jsx
var import_react3 = require("react");
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// client/src/ServersSection.jsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
function destinationOf(host) {
  return `${host.user ? `${host.user}@` : ""}${host.host}${host.port ? `:${host.port}` : ""}`;
}
function StatusLine({ host, t }) {
  const status = host.state?.status ?? "idle";
  const text = status === "connected" ? t("state.connected", { os: host.state.os, arch: host.state.arch }) : status === "error" ? t("state.error") : t("state.idle");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sf-status", title: host.state?.error ?? "", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `sf-dot sf-dot-${status}` }),
    text
  ] });
}
function testText(result, t) {
  if (result.ok) {
    const extras = `${result.bwrap ? t("test.bwrap") : ""}${result.rg ? t("test.rg") : ""}`;
    return t("test.ok", { os: result.os, arch: result.arch, home: result.home, ms: String(result.latencyMs), extras });
  }
  return t("test.failed", { error: result.error });
}
var EMPTY = { id: "", host: "", user: "", port: "", identityFile: "", workspace: "", description: "", sshOptions: "", sandbox: "auto", proxy: false };
function toForm(host) {
  return {
    ...EMPTY,
    ...host,
    port: host.port === void 0 ? "" : String(host.port),
    sshOptions: (host.sshOptions ?? []).join("\n"),
    sandbox: host.sandbox ?? "auto",
    proxy: host.proxy === true
  };
}
function fromForm(form) {
  const host = { id: form.id.trim(), host: form.host.trim() };
  for (const key of ["user", "identityFile", "workspace", "description"]) if (form[key].trim() !== "") host[key] = form[key].trim();
  if (form.port.trim() !== "") host.port = Number(form.port);
  const options = form.sshOptions.split("\n").map((s) => s.trim()).filter(Boolean);
  if (options.length > 0) host.sshOptions = options;
  if (form.sandbox !== "auto") host.sandbox = form.sandbox;
  if (form.proxy) host.proxy = true;
  return host;
}
function Field({ label, hint, wide, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: `sf-field${wide ? " sf-field-wide" : ""}`, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-label", children: label }),
    children,
    hint ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-hint", children: hint }) : null
  ] });
}
function HostEditor({ api, t, initial, creating, onClose, onSaved }) {
  const [form, setForm] = (0, import_react.useState)(() => toForm(initial ?? {}));
  const [error, setError] = (0, import_react.useState)("");
  const [testing, setTesting] = (0, import_react.useState)(false);
  const [result, setResult] = (0, import_react.useState)(void 0);
  const [saving, setSaving] = (0, import_react.useState)(false);
  const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const test = async () => {
    setTesting(true);
    setResult(void 0);
    setError("");
    try {
      setResult(await api.test(fromForm(form)));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api.save(fromForm(form), creating);
      onSaved();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: creating ? t("editor.addTitle") : t("editor.editTitle", { id: initial.id }),
      description: t("editor.description"),
      className: "sf-modal sf-modal-wide",
      closeLabel: t("action.close"),
      footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-footer", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: test, disabled: testing || form.host.trim() === "" || form.id.trim() === "", children: testing ? t("state.testing") : t("action.test") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-footer-spacer" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose, children: t("action.cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", onClick: save, disabled: saving || form.host.trim() === "" || form.id.trim() === "", children: t("action.save") })
      ] }),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-form", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.id"), hint: creating ? t("field.idHint") : void 0, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.id, onChange: set("id"), disabled: !creating, placeholder: "web1", "data-modal-autofocus": "" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.host"), hint: t("field.hostHint"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.host, onChange: set("host"), placeholder: "web1.example.com" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.user"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.user, onChange: set("user"), placeholder: "deploy" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.port"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.port, onChange: set("port"), placeholder: "22", inputMode: "numeric" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.identityFile"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.identityFile, onChange: set("identityFile"), placeholder: "~/.ssh/id_ed25519" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.workspace"), hint: t("field.workspaceHint"), children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.workspace, onChange: set("workspace"), placeholder: "~/app" }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.description"), wide: true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: form.description, onChange: set("description") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: t("field.sshOptions"), hint: t("field.sshOptionsHint"), wide: true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { className: "sf-textarea", value: form.sshOptions, onChange: set("sshOptions"), spellCheck: false }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-field sf-field-wide", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-label", children: t("field.sandbox") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              import_dsh_client_ui_primitives.SegmentedControl,
              {
                className: "sf-segmented",
                id: "ssh-fleet-sandbox",
                label: t("field.sandbox"),
                value: form.sandbox,
                onChange: (sandbox) => setForm((prev) => ({ ...prev, sandbox })),
                options: [
                  { value: "auto", label: t("sandbox.auto") },
                  { value: "unconfined", label: t("sandbox.unconfined") },
                  { value: "refuse", label: t("sandbox.refuse") }
                ]
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-hint", children: t(`sandbox.${form.sandbox}Hint`) })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-switch-row sf-field-wide", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sf-switch-text", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-label", children: t("field.proxy") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-hint", children: t("field.proxyHint") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Switch, { checked: form.proxy, onChange: (proxy) => setForm((prev) => ({ ...prev, proxy })), label: t("field.proxy") })
          ] })
        ] }),
        result ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `sf-result ${result.ok ? "sf-result-ok" : "sf-result-error"}`, children: testText(result, t) }) : null,
        error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-error", children: error }) : null
      ]
    }
  );
}
function ImportDialog({ api, t, onClose, onImported }) {
  const [path, setPath] = (0, import_react.useState)("~/.ssh/config");
  const [listing, setListing] = (0, import_react.useState)(void 0);
  const [selected, setSelected] = (0, import_react.useState)(() => /* @__PURE__ */ new Set());
  const [error, setError] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const load = (0, import_react.useCallback)(async (configPath) => {
    setBusy(true);
    setError("");
    try {
      const result = await api.sshConfig(configPath === "~/.ssh/config" ? void 0 : configPath);
      setListing(result);
      setSelected(new Set(result.candidates.filter((c) => c.configuredAs === void 0).map((c) => c.alias)));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  }, [api]);
  (0, import_react.useEffect)(() => {
    void load("~/.ssh/config");
  }, [load]);
  const toggle = (alias, on) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(alias);
    else next.delete(alias);
    return next;
  });
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api.importSshConfig([...selected], path === "~/.ssh/config" ? void 0 : path);
      onImported();
    } catch (cause) {
      setError(cause.message);
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    import_dsh_client_ui_primitives.Modal,
    {
      open: true,
      onClose,
      title: t("import.title"),
      description: t("import.description"),
      className: "sf-modal sf-modal-wide",
      closeLabel: t("action.close"),
      footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-footer", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: onClose, children: t("action.cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", onClick: submit, disabled: busy || selected.size === 0, children: t("action.importSelected", { count: String(selected.size) }) })
      ] }),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-inline", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Input, { value: path, onChange: (event) => setPath(event.target.value), "aria-label": t("import.path") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => load(path), disabled: busy, children: t("action.load") })
        ] }),
        listing && listing.candidates.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-caption", children: t("import.none") }) : null,
        listing && listing.candidates.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "sf-list", children: listing.candidates.map((candidate) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "sf-import-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            import_dsh_client_ui_primitives.Checkbox,
            {
              checked: selected.has(candidate.alias),
              disabled: candidate.configuredAs !== void 0,
              onChange: (on) => toggle(candidate.alias, on),
              label: candidate.alias
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-import-meta", children: candidate.configuredAs !== void 0 ? t("import.configured", { id: candidate.configuredAs }) : `${candidate.user ? `${candidate.user}@` : ""}${candidate.hostname ?? candidate.alias}${candidate.port && candidate.port !== 22 ? `:${candidate.port}` : ""}${candidate.proxyJump ? ` via ${candidate.proxyJump}` : ""}` })
        ] }, candidate.alias)) }) : null,
        error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-error", children: error }) : null
      ]
    }
  );
}
function ServersSection({ api, t }) {
  const [data, setData] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)("");
  const [editing, setEditing] = (0, import_react.useState)(void 0);
  const [importing, setImporting] = (0, import_react.useState)(false);
  const [removing, setRemoving] = (0, import_react.useState)(void 0);
  const [tests, setTests] = (0, import_react.useState)({});
  const refresh = (0, import_react.useCallback)(async () => {
    try {
      setData(await api.hosts());
      setError("");
    } catch (cause) {
      setError(cause.message);
    }
  }, [api]);
  (0, import_react.useEffect)(() => {
    void refresh();
  }, [refresh]);
  const test = async (host) => {
    setTests((prev) => ({ ...prev, [host.id]: "testing" }));
    try {
      const result = await api.test(fromForm(toForm(host)));
      setTests((prev) => ({ ...prev, [host.id]: result }));
    } catch (cause) {
      setTests((prev) => ({ ...prev, [host.id]: { ok: false, error: cause.message } }));
    }
    void refresh();
  };
  const confirmRemove = async () => {
    try {
      await api.remove(removing.id);
      setRemoving(void 0);
      void refresh();
    } catch (cause) {
      setError(cause.message);
      setRemoving(void 0);
    }
  };
  const hosts = data?.hosts ?? [];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "sf-section", "data-testid": "ssh-fleet-servers", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { className: "sf-title", children: t("section.title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-intro", children: t("section.intro") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 16 }), onClick: () => setEditing({ creating: true, host: void 0 }), children: t("action.add") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", onClick: () => setImporting(true), children: t("action.import") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 16 }), onClick: refresh, children: t("action.refresh") })
    ] }),
    data?.hostsFile ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-caption", children: t("section.file", { path: data.hostsFile }) }) : null,
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-error", children: error }) : null,
    data && hosts.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "sf-caption", children: t("section.empty") }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { className: "sf-rows", children: hosts.map((host) => {
      const result = tests[host.id];
      const readonly = host.source === "config";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { className: "sf-card", "data-server": host.id, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-card-head", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-card-identity", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sf-card-name", children: [
              host.id,
              readonly ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tag, { children: t("tag.readonly") }) : null
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "sf-card-dest", children: [
              destinationOf(host),
              host.workspace ? `  ·  ${host.workspace}` : ""
            ] }),
            host.description ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sf-caption", children: host.description }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatusLine, { host, t }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-card-buttons", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", onClick: () => test(host), disabled: result === "testing", children: result === "testing" ? t("state.testing") : t("action.test") }),
            readonly ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconEditOutlineRegular, { size: 16 }), "aria-label": t("action.edit"), title: t("action.edit"), onClick: () => setEditing({ creating: false, host }) }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconTrashOutlineRegular, { size: 16 }), "aria-label": t("action.remove"), title: t("action.remove"), onClick: () => setRemoving(host) })
            ] })
          ] })
        ] }),
        result !== void 0 && result !== "testing" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: `sf-result ${result.ok ? "sf-result-ok" : "sf-result-error"}`, children: testText(result, t) }) : null
      ] }, host.id);
    }) }),
    editing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      HostEditor,
      {
        api,
        t,
        initial: editing.host,
        creating: editing.creating,
        onClose: () => setEditing(void 0),
        onSaved: () => {
          setEditing(void 0);
          void refresh();
        }
      }
    ) : null,
    importing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ImportDialog, { api, t, onClose: () => setImporting(false), onImported: () => {
      setImporting(false);
      void refresh();
    } }) : null,
    removing ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      import_dsh_client_ui_primitives.Modal,
      {
        open: true,
        onClose: () => setRemoving(void 0),
        title: t("remove.title", { id: removing.id }),
        description: t("remove.body"),
        closeLabel: t("action.close"),
        footer: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "sf-footer", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "ghost", onClick: () => setRemoving(void 0), children: t("action.cancel") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "primary", onClick: confirmRemove, children: t("action.remove") })
        ] })
      }
    ) : null
  ] });
}

// client/src/RemoteBrowser.jsx
var import_react2 = require("react");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime2 = require("react/jsx-runtime");
function RemoteBrowser({ hostId, listDirectory, createDirectory, busy, t, onOpen, onClose }) {
  const [listing, setListing] = (0, import_react2.useState)(void 0);
  const [loading, setLoading] = (0, import_react2.useState)(true);
  const [error, setError] = (0, import_react2.useState)("");
  const [pathDraft, setPathDraft] = (0, import_react2.useState)("");
  const [showHidden, setShowHidden] = (0, import_react2.useState)(false);
  const [creating, setCreating] = (0, import_react2.useState)(false);
  const [folderName, setFolderName] = (0, import_react2.useState)("");
  const load = async (path) => {
    setLoading(true);
    setError("");
    try {
      const next = await listDirectory(path);
      setListing(next);
      setPathDraft(next.path);
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  };
  (0, import_react2.useEffect)(() => {
    void load(void 0);
  }, [hostId]);
  const create = async () => {
    if (listing === void 0 || folderName.trim() === "") return;
    try {
      const created = await createDirectory(listing.path, folderName.trim());
      setCreating(false);
      setFolderName("");
      await load(created);
    } catch (cause) {
      setError(cause.message);
    }
  };
  const entries = (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    import_dsh_client_ui_primitives2.Modal,
    {
      open: true,
      onClose,
      title: t("browser.title", { host: hostId }),
      closeLabel: t("action.close"),
      footer: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sf-footer", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Checkbox, { checked: showHidden, onChange: setShowHidden, label: t("browser.showHidden") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sf-footer-spacer" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "outline", icon: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconPlusOutlineRegular, { size: 16 }), onClick: () => setCreating(true), disabled: listing === void 0, children: t("browser.newFolder") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "ghost", onClick: onClose, children: t("action.cancel") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "primary", onClick: () => listing && onOpen(listing.path), disabled: busy || listing === void 0 || listing.path === "/", children: t("browser.open") })
      ] }),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "sf-inline", onSubmit: (event) => {
          event.preventDefault();
          void load(pathDraft);
        }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Input, { value: pathDraft, onChange: (event) => setPathDraft(event.target.value), "aria-label": t("browser.path"), spellCheck: false }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "outline", type: "submit", children: t("browser.go") })
        ] }),
        listing ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("nav", { className: "sf-crumbs", "aria-label": t("browser.path"), children: listing.crumbs.map((crumb, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "sf-inline", children: [
          index > 1 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronRightOutlineRegular, { size: 12 }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              className: `sf-crumb${index === listing.crumbs.length - 1 ? " sf-crumb-current" : ""}`,
              onClick: () => load(crumb.path),
              children: crumb.name
            }
          )
        ] }, crumb.path)) }) : null,
        creating ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("form", { className: "sf-inline", onSubmit: (event) => {
          event.preventDefault();
          void create();
        }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Input, { value: folderName, onChange: (event) => setFolderName(event.target.value), placeholder: t("browser.folderName"), "data-modal-autofocus": "" }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "primary", type: "submit", disabled: folderName.trim() === "", children: t("browser.create") }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Button, { variant: "ghost", type: "button", onClick: () => setCreating(false), children: t("action.cancel") })
        ] }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("ul", { className: "sf-browser-list", children: [
          loading ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: "sf-busy", children: t("browser.loading") }) : null,
          !loading && entries.length === 0 && !error ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: "sf-busy", children: t("browser.empty") }) : null,
          !loading && entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: `sf-browser-row${entry.hidden ? " sf-browser-row-hidden" : ""}`, onClick: () => load(entry.path), children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconFolderCloseRegular, { size: 16 }),
            entry.name
          ] }) }, entry.path))
        ] }),
        listing?.truncated ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "sf-caption", children: t("browser.truncated") }) : null,
        error ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "sf-error", children: error }) : null
      ]
    }
  );
}

// client/src/DirectoryFlow.jsx
var import_jsx_runtime3 = require("react/jsx-runtime");
function DirectoryFlow(props) {
  const { open, busy, onPicked, onCancel, onError, api, t, shadowed } = props;
  const [stage, setStage] = (0, import_react3.useState)("closed");
  const [hosts, setHosts] = (0, import_react3.useState)([]);
  const [adopting, setAdopting] = (0, import_react3.useState)(false);
  const chooserShown = (0, import_react3.useRef)(false);
  (0, import_react3.useEffect)(() => {
    if (!open) {
      setStage("closed");
      chooserShown.current = false;
      return;
    }
    if (stage !== "closed") return;
    setStage("loading");
    api.hosts().then(
      (data) => {
        const list = data.hosts ?? [];
        setHosts(list);
        chooserShown.current = list.length > 0;
        setStage(list.length > 0 ? "choose" : "local");
      },
      () => {
        chooserShown.current = false;
        setStage("local");
      }
    );
  }, [open]);
  if (!open || stage === "closed" || stage === "loading") return null;
  const back = () => {
    if (chooserShown.current) setStage("choose");
    else onCancel();
  };
  if (stage === "choose") {
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_dsh_client_ui_primitives3.Modal, { open: true, onClose: onCancel, title: t("flow.title"), description: t("flow.description"), closeLabel: t("action.close"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("ul", { className: "sf-list", "data-testid": "ssh-fleet-location", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("button", { type: "button", className: "sf-option", onClick: () => setStage("local"), "data-modal-autofocus": "", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "sf-option-icon", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives3.IconFolderOpenRegular, { size: 20 }) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "sf-option-text", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "sf-option-title", children: t("flow.local") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "sf-option-sub", children: t("flow.localHint") })
          ] })
        ] }) }),
        hosts.map((host2) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("button", { type: "button", className: "sf-option", "data-server": host2.id, onClick: () => setStage({ host: host2.id }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "sf-option-icon", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(import_dsh_client_ui_primitives3.IconGlobeOutlineRegular, { size: 20 }) }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "sf-option-text", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "sf-option-title", children: host2.id }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("span", { className: "sf-option-sub", children: [
              destinationOf(host2),
              host2.description ? ` · ${host2.description}` : ""
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: `sf-dot sf-dot-${host2.state?.status ?? "idle"}` })
        ] }) }, host2.id))
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "sf-caption", children: t("flow.manage") })
    ] });
  }
  const entry = shadowed();
  if (stage === "local") {
    if (entry === void 0) {
      queueMicrotask(() => onError("no directory picker is available"));
      return null;
    }
    return (0, import_react3.createElement)(entry.component, {
      ...entry.face,
      open,
      busy,
      onPicked,
      onError,
      onCancel: back
    });
  }
  const hostId = stage.host;
  const host = hosts.find((h) => h.id === hostId);
  const start = host?.workspace;
  const listDirectory = (path, signal) => api.listDirectory(hostId, path ?? start, signal);
  const createDirectory = (path, name) => api.createDirectory(hostId, path, name);
  const adopt = async (remotePath) => {
    setAdopting(true);
    try {
      const workspace = await api.createWorkspace(hostId, remotePath);
      onPicked(workspace.path);
    } catch (cause) {
      onError(cause.message);
    } finally {
      setAdopting(false);
    }
  };
  if (entry !== void 0 && typeof entry.face.listDirectory === "function") {
    const browseT = typeof entry.face.t === "function" ? (key, params) => key === "browser.title" ? t("browser.title", { host: hostId }) : entry.face.t(key, params) : entry.face.t;
    return (0, import_react3.createElement)(entry.component, {
      ...entry.face,
      key: `remote:${hostId}`,
      t: browseT,
      listDirectory,
      createDirectory,
      open,
      busy: busy || adopting,
      onPicked: adopt,
      onError,
      onCancel: back
    });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    RemoteBrowser,
    {
      hostId,
      listDirectory,
      createDirectory,
      busy: busy || adopting,
      t,
      onOpen: adopt,
      onClose: back
    },
    hostId
  );
}

// client/src/i18n.js
var NS = "ssh-fleet";
var zh = {
  "nav": "服务器",
  "section.title": "SSH 服务器",
  "section.intro": "在这里登记的服务器可以作为工作区位置：添加工作区时选择服务器上的目录，该工作区里的会话就会在那台服务器上读写文件、执行命令。模型调用、插件和技能仍然只在本机运行。",
  "section.empty": "还没有服务器。可以手动添加，或从 ~/.ssh/config 导入。",
  "section.file": "配置保存在 {path}",
  "action.add": "添加服务器",
  "action.import": "从 ~/.ssh/config 导入",
  "action.refresh": "刷新",
  "action.test": "测试连接",
  "action.edit": "编辑",
  "action.remove": "删除",
  "action.save": "保存",
  "action.cancel": "取消",
  "action.close": "关闭",
  "action.importSelected": "导入所选（{count}）",
  "action.load": "读取",
  "state.connected": "已连接 · {os}/{arch}",
  "state.idle": "未连接",
  "state.error": "连接失败",
  "state.testing": "正在测试…",
  "test.ok": "连接成功：{os}/{arch}，主目录 {home}，耗时 {ms} ms{extras}",
  "test.bwrap": "，支持 bwrap 沙箱",
  "test.rg": "，已安装 ripgrep",
  "test.failed": "连接失败：{error}",
  "tag.readonly": "由 cordis.patch.yml 定义",
  "editor.addTitle": "添加服务器",
  "editor.editTitle": "编辑 {id}",
  "editor.description": "需要能用密钥或 ssh-agent 免密登录（BatchMode）。主机可以直接写 ~/.ssh/config 里的别名。",
  "field.id": "名称",
  "field.idHint": "用于区分服务器，保存后不可修改",
  "field.host": "主机",
  "field.hostHint": "ssh 目标：~/.ssh/config 别名、主机名或 IP",
  "field.user": "用户",
  "field.port": "端口",
  "field.identityFile": "私钥文件",
  "field.workspace": "默认目录",
  "field.workspaceHint": "绝对路径或 ~/…，默认主目录",
  "field.description": "备注",
  "field.sshOptions": "SSH 选项",
  "field.sshOptionsHint": "每行一个 Key=Value，例如 ProxyJump=bastion",
  "field.sandbox": "命令沙箱",
  "field.proxy": "主机代理",
  "field.proxyHint": "经 SSH 反向转发把本机的 HTTP 代理提供给这台服务器（设置 HTTP(S)_PROXY），适合服务器无法直接联网的情况",
  "sandbox.auto": "自动",
  "sandbox.unconfined": "不限制",
  "sandbox.refuse": "拒绝",
  "sandbox.autoHint": "服务器装有 bubblewrap 时按会话权限模式限制命令；没有时，受限模式下的命令会被拒绝",
  "sandbox.unconfinedHint": "受限模式下也不限制命令（只限制文件工具的写入）",
  "sandbox.refuseHint": "受限模式下总是拒绝执行命令",
  "remove.title": "删除服务器 {id}？",
  "remove.body": "已经绑定到这台服务器的会话将无法继续执行，直到你重新添加同名服务器。服务器上的文件不会受影响。",
  "import.title": "从 SSH 配置导入",
  "import.description": "列出配置文件中的 Host 条目（包括 Include 的文件）。导入后直接使用别名连接，原有的 ProxyJump、IdentityFile 等设置继续生效。",
  "import.path": "配置文件",
  "import.none": "没有找到可导入的 Host 条目。",
  "import.configured": "已添加为 {id}",
  "import.done": "已导入 {count} 台服务器",
  "flow.title": "添加工作区",
  "flow.description": "选择目录所在的位置",
  "flow.local": "本机",
  "flow.localHint": "运行 DeepSeek Harness 的这台机器",
  "flow.manage": "在 设置 → 服务器 中管理服务器",
  "flow.adopting": "正在创建工作区…",
  "browser.title": "选择 {host} 上的目录",
  "browser.open": "打开",
  "browser.up": "上一级",
  "browser.newFolder": "新建文件夹",
  "browser.folderName": "文件夹名称",
  "browser.create": "创建",
  "browser.loading": "加载中…",
  "browser.empty": "没有子目录",
  "browser.truncated": "目录过多，仅显示前 1000 个。",
  "browser.showHidden": "显示隐藏目录",
  "browser.path": "路径",
  "browser.go": "前往"
};
var en = {
  "nav": "Servers",
  "section.title": "SSH servers",
  "section.intro": "Servers registered here can hold workspaces: when you add a workspace, pick a directory on a server and the sessions in it read, write and run commands on that server. Model calls, plugins and skills stay on this machine.",
  "section.empty": "No servers yet. Add one, or import from ~/.ssh/config.",
  "section.file": "Stored in {path}",
  "action.add": "Add server",
  "action.import": "Import from ~/.ssh/config",
  "action.refresh": "Refresh",
  "action.test": "Test connection",
  "action.edit": "Edit",
  "action.remove": "Remove",
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.close": "Close",
  "action.importSelected": "Import selected ({count})",
  "action.load": "Load",
  "state.connected": "Connected · {os}/{arch}",
  "state.idle": "Not connected",
  "state.error": "Connection failed",
  "state.testing": "Testing…",
  "test.ok": "Connected: {os}/{arch}, home {home}, {ms} ms{extras}",
  "test.bwrap": ", bwrap sandbox available",
  "test.rg": ", ripgrep installed",
  "test.failed": "Connection failed: {error}",
  "tag.readonly": "Defined in cordis.patch.yml",
  "editor.addTitle": "Add server",
  "editor.editTitle": "Edit {id}",
  "editor.description": "Key or ssh-agent login is required (BatchMode). The host may be an alias from ~/.ssh/config.",
  "field.id": "Name",
  "field.idHint": "Identifies the server; cannot be changed later",
  "field.host": "Host",
  "field.hostHint": "ssh destination: ~/.ssh/config alias, hostname or IP",
  "field.user": "User",
  "field.port": "Port",
  "field.identityFile": "Identity file",
  "field.workspace": "Default directory",
  "field.workspaceHint": "Absolute path or ~/…; defaults to home",
  "field.description": "Note",
  "field.sshOptions": "SSH options",
  "field.sshOptionsHint": "One Key=Value per line, e.g. ProxyJump=bastion",
  "field.sandbox": "Command sandbox",
  "field.proxy": "Host proxy",
  "field.proxyHint": "Offer this machine's HTTP proxy to the server over an SSH reverse forward (sets HTTP(S)_PROXY), for servers without direct network access",
  "sandbox.auto": "Auto",
  "sandbox.unconfined": "Unconfined",
  "sandbox.refuse": "Refuse",
  "sandbox.autoHint": "Confines commands by the session permission mode when the server has bubblewrap; without it, confined commands are refused",
  "sandbox.unconfinedHint": "Commands are not confined even in confined modes (file tools still are)",
  "sandbox.refuseHint": "Always refuse commands in confined modes",
  "remove.title": "Remove server {id}?",
  "remove.body": "Sessions bound to this server stop running until a server with the same name is added again. Files on the server are not touched.",
  "import.title": "Import from SSH config",
  "import.description": "Lists Host entries of the config file (including Include files). Imported servers connect through the alias, so ProxyJump, IdentityFile and other settings keep applying.",
  "import.path": "Config file",
  "import.none": "No importable Host entries found.",
  "import.configured": "Added as {id}",
  "import.done": "Imported {count} server(s)",
  "flow.title": "Add workspace",
  "flow.description": "Choose where the directory is",
  "flow.local": "This computer",
  "flow.localHint": "The machine running DeepSeek Harness",
  "flow.manage": "Manage servers in Settings → Servers",
  "flow.adopting": "Creating workspace…",
  "browser.title": "Choose a directory on {host}",
  "browser.open": "Open",
  "browser.up": "Up",
  "browser.newFolder": "New folder",
  "browser.folderName": "Folder name",
  "browser.create": "Create",
  "browser.loading": "Loading…",
  "browser.empty": "No subdirectories",
  "browser.truncated": "Too many directories; showing the first 1000.",
  "browser.showHidden": "Show hidden directories",
  "browser.path": "Path",
  "browser.go": "Go"
};

// client/src/styles.js
var CSS = `
.sf-section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.sf-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }
.sf-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.sf-caption { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.sf-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sf-rows { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.sf-card { border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.sf-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sf-card-identity { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.sf-card-name { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; line-height: 22px; font-weight: 500; }
.sf-card-dest { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); font-family: var(--dsw-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-card-buttons { display: flex; gap: 4px; flex: none; }
.sf-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.sf-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-state-idle-primary); }
.sf-dot-connected { background: var(--dsw-alias-state-success-primary); }
.sf-dot-error { background: var(--dsw-alias-state-error-primary); }
.sf-result { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.sf-result-ok { color: var(--dsw-alias-state-success-primary); }
.sf-result-error { color: var(--dsw-alias-state-error-primary); }
.sf-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 12px; }
.sf-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.sf-field-wide { grid-column: 1 / -1; }
.sf-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.sf-hint { font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.sf-textarea { box-sizing: border-box; width: 100%; min-height: 64px; resize: vertical; padding: 6px 10px; border-radius: var(--dsw-radius-md); border: 0.5px solid var(--dsw-alias-border-l3); background: transparent; color: var(--dsw-alias-label-primary); font: 13px/20px var(--dsw-font-mono); outline: none; }
.sf-textarea:focus { border-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.sf-footer { display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.sf-footer-spacer { flex: 1; }
.sf-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 340px; overflow: auto; }
.sf-option { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box; padding: 10px 12px; border: 0; border-radius: var(--dsw-radius-lg); background: transparent; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; font: inherit; }
.sf-option:hover:not(:disabled), .sf-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.sf-option:disabled { cursor: default; opacity: .55; }
.sf-option-icon { display: inline-flex; color: var(--dsw-alias-label-secondary); flex: none; }
.sf-option-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.sf-option-title { font-size: 14px; line-height: 20px; font-weight: 500; }
.sf-option-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-import-row { display: flex; align-items: center; gap: 10px; padding: 6px 4px; }
.sf-import-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sf-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; font-size: 13px; }
.sf-crumb { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); padding: 2px 4px; border-radius: 6px; cursor: pointer; font: inherit; }
.sf-crumb:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.sf-crumb-current { color: var(--dsw-alias-label-primary); font-weight: 500; }
.sf-browser-list { list-style: none; margin: 0; padding: 4px; height: 280px; overflow: auto; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); }
.sf-browser-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; font: inherit; font-size: 13px; }
.sf-browser-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.sf-browser-row-hidden { color: var(--dsw-alias-label-tertiary); }
.sf-inline { display: flex; gap: 8px; align-items: center; }
.sf-inline > :first-child { flex: 1; min-width: 0; }
.sf-modal.sf-modal-wide { width: min(600px, calc(100vw - 32px)); }
.sf-segmented { align-self: flex-start; }
.sf-switch-row { display: flex; align-items: center; gap: 16px; justify-content: space-between; }
.sf-switch-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sf-error { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.sf-busy { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
`;
var TAG = "dsh-ssh-fleet/styles";
function installStyles() {
  if (typeof document === "undefined") return () => {
  };
  let tag = document.querySelector(`style[data-plugin-css="${TAG}"]`);
  if (tag === null) {
    tag = document.createElement("style");
    tag.setAttribute("data-plugin-css", TAG);
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }
  return () => tag?.remove();
}

// client/src/index.jsx
var HOLES = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => installStyles(), "dsh-ssh-fleet: styles");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-ssh-fleet: copy dictionaries");
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "ssh-fleet",
    order: 45,
    label: () => t("nav"),
    inject: () => ({ api: fleetApi, t })
  }, ServersSection));
  const shadowedOf = (hole) => () => {
    const candidates = ctx.slots.entries(hole).filter((entry2) => entry2.component !== DirectoryFlow).sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
    const entry = candidates[0];
    return entry === void 0 ? void 0 : { component: entry.component, face: entry.inject ? entry.inject() : {} };
  };
  ctx.slots.inject(HOLES[0], () => ctx.slots.inject(HOLES[1], function* () {
    for (const hole of HOLES) {
      yield ctx.slots.register({
        name: hole,
        priority: -1,
        inject: () => ({ api: fleetApi, t, shadowed: shadowedOf(hole) })
      }, DirectoryFlow);
    }
  }));
}

		return module.exports;
	}
});
