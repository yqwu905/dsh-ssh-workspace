/** Native DSH Web panel for SSH servers, mounted workspaces and conversations. */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SandboxChecks } from './sandbox-diagnostics.js'

const NS = 'ssh-workspaces'
const PANEL_ID = 'ssh-workspaces' as MainPanelId
const zh = {
  panel: 'SSH 工作区', subtitle: '在远程服务器上开发，沿用当前 Host 的模型、插件与 Skills。',
  servers: 'SSH 服务器', workspaces: '远程工作区', conversations: '工作区对话',
  refresh: '刷新', loading: '加载中…', working: '处理中…', saved: '已完成', close: '关闭',
  addServer: '添加服务器', editServer: '编辑服务器', label: '显示名称', host: 'SSH Host 别名',
  fromConfig: '从 ~/.ssh/config 选择', configPlaceholder: '选择 Host 上已配置的服务器…', configEmpty: '未找到具体 Host 别名，可在下方直接填写。',
  configHelp: '读取运行 DSH 的 Host 配置及 Include 文件；连接沿用 OpenSSH 的密钥、端口和跳板机设置。',
  helperMode: 'Helper 安装', autoHelper: '自动安装（推荐）', manualHelper: '手动指定（高级）',
  autoHelp: '首次连接时自动安装匹配版本的 Helper 和 Node，远端无需联网。可关闭本面板，安装会在后台继续。',
  installing: '安装中', detecting: '检测远程平台…', preparing: 'Host 正在准备运行包…', uploading: '经 SSH 上传并安装…', verifying: '校验远程运行包…',
  connectionStarted: '连接任务已启动，进度见服务器状态。',
  hostHelp: '使用 Host 上已配置的 OpenSSH 别名、密钥及 known_hosts；浏览器不接收私钥。',
  helper: '远程 Helper 绝对路径', helperHash: 'Helper SHA-256', launch: 'Helper 启动方式',
  executable: '独立可执行文件', nodeScript: 'Node.js 脚本', node: '远程 Node.js 绝对路径',
  advanced: '高级选项', tunnels: '反向隧道（JSON 数组）', executableMap: '程序路径映射（JSON 对象）',
  hostExecutables: '固定在 Host 执行的程序（JSON 数组）', hostExecutablesHelp: '只填写确实应留在 Host 的程序路径；其余工作区命令转到远程执行。',
  bootstrapPath: 'PTC Bootstrap 绝对路径（可选）', bootstrapHash: 'PTC Bootstrap SHA-256（可选）', validationBootstrap: 'Bootstrap 路径与 SHA-256 必须同时填写。', validationHostExecutables: 'Host 程序须为非空字符串组成的 JSON 数组。',
  tunnelsHelp: '远程 127.0.0.1:remotePort → Host 的 host:port。模型请求默认由 Host 直接发送，无需隧道。',
  mapHelp: '例如 {"/usr/bin/bash":"/bin/bash"}，将 Host 的程序路径映射到远程程序路径。',
  save: '保存', cancel: '取消', edit: '编辑', remove: '删除', connect: '连接', disconnect: '断开',
  probe: '检查连接与沙箱', noServers: '添加第一台服务器，然后连接并添加远程目录。',
  sandboxHost: 'Host 沙箱', sandboxRemote: '远程沙箱', sandboxSelected: '已选择后端', sandboxUnavailable: '后端不可用', sandboxError: '检测失败',
  sandboxFull: '完整约束', sandboxPartial: '部分约束', sandboxHint: '这是只读后端预检，命令仍须通过运行时检查。Linux 需可用的 bubblewrap 或 Landlock；macOS 需 sandbox-exec。修复远程环境后断开重连；修复 Host 后重启 DSH。',
  noWorkspaces: '此服务器还没有工作区。', noSessions: '此工作区还没有对话。',
  selectServer: '选择服务器', selectedServer: '当前服务器', remotePath: '远程目录绝对路径', title: '工作区名称',
  addWorkspace: '添加工作区', mount: '挂载', unmount: '卸载', open: '打开', newSession: '新建对话',
  viewSessions: '查看对话', archive: '归档', restore: '恢复', showArchived: '显示已归档', running: '运行中',
  disconnectConfirm: '断开服务器将影响该服务器上的工作区和运行中的命令，是否继续？',
  unmountConfirm: '卸载工作区前请停止使用它的命令和编辑器。是否继续？',
  deleteServerConfirm: '删除此服务器配置？请先移除其工作区。不会删除远程文件。',
  deleteWorkspaceConfirm: '移除此工作区注册？不会删除远程文件或已保存的对话。',
  connected: '已连接', disconnected: '未连接', connecting: '连接中', mounted: '已挂载', unmounted: '未挂载',
  mounting: '挂载中', error: '错误', ready: '就绪', idle: '空闲', unknown: '未知',
  validationAlias: 'SSH 别名只能包含字母、数字、点、下划线、@ 和连字符，且不能以连字符开头。',
  validationPath: '请填写绝对路径，不能包含换行或 NUL。', validationHash: 'SHA-256 必须为 64 位十六进制字符串。',
  validationTunnels: '隧道须为数组，各项包含有效的 remotePort、host、port。',
  validationMap: '程序映射须为 JSON 对象，键和值均为非空字符串。',
  requestFailed: '请求失败', invalidResponse: '服务器返回了无效响应。',
  mountRequired: '请先连接服务器并挂载工作区。', nativePending: '等待 DSH 同步工作区，请稍后重试。',
  authError: 'DSH 登录已失效或请求被拒绝，请刷新页面并重新登录。',
  selectedWorkspace: '当前工作区', mountPath: 'Host 挂载路径', closeEditor: '关闭编辑器',
  serverCount: '台服务器', workspaceCount: '个工作区', helperHelp: '仅用于接管已有 Helper；新服务器保持默认的自动安装即可。',
  status: '状态', inspectDetails: '详细信息', noSelection: '选择一个工作区以查看对话。',
} as const
const en: Record<keyof typeof zh, string> = {
  panel: 'SSH Workspaces', subtitle: 'Develop on remote servers with this Host’s models, plugins and skills.',
  servers: 'SSH servers', workspaces: 'Remote workspaces', conversations: 'Workspace conversations',
  refresh: 'Refresh', loading: 'Loading…', working: 'Working…', saved: 'Done', close: 'Close',
  addServer: 'Add server', editServer: 'Edit server', label: 'Display name', host: 'SSH Host alias',
  fromConfig: 'Choose from ~/.ssh/config', configPlaceholder: 'Select a configured SSH server…', configEmpty: 'No concrete Host aliases found. Enter an alias below.',
  configHelp: 'Reads the DSH Host’s config and Include files. OpenSSH retains keys, ports and jump hosts.',
  helperMode: 'Helper installation', autoHelper: 'Automatic (recommended)', manualHelper: 'Manual (advanced)',
  autoHelp: 'First connection installs a matching Helper and Node automatically. The remote needs no internet. Setup continues if you close this panel.',
  installing: 'Installing', detecting: 'Detecting remote platform…', preparing: 'Preparing runtime on Host…', uploading: 'Uploading and installing over SSH…', verifying: 'Verifying remote runtime…',
  connectionStarted: 'Connection started. Follow progress in the server status.',
  hostHelp: 'Uses the Host’s existing OpenSSH alias, keys and known_hosts. Private keys never enter the browser.',
  helper: 'Remote Helper absolute path', helperHash: 'Helper SHA-256', launch: 'Helper launch mode',
  executable: 'Standalone executable', nodeScript: 'Node.js script', node: 'Remote Node.js absolute path',
  advanced: 'Advanced options', tunnels: 'Reverse tunnels (JSON array)', executableMap: 'Executable paths (JSON object)',
  hostExecutables: 'Host-only executables (JSON array)', hostExecutablesHelp: 'Only list programs that must remain on the Host; other workspace commands execute remotely.',
  bootstrapPath: 'PTC Bootstrap absolute path (optional)', bootstrapHash: 'PTC Bootstrap SHA-256 (optional)', validationBootstrap: 'Bootstrap path and SHA-256 must be supplied together.', validationHostExecutables: 'Host executables must be a JSON array of nonempty strings.',
  tunnelsHelp: 'Remote 127.0.0.1:remotePort → Host host:port. Model requests already run on the Host and need no tunnel.',
  mapHelp: 'For example {"/usr/bin/bash":"/bin/bash"} maps a Host executable path to its remote executable.',
  save: 'Save', cancel: 'Cancel', edit: 'Edit', remove: 'Delete', connect: 'Connect', disconnect: 'Disconnect',
  probe: 'Check connection and sandbox', noServers: 'Add your first server, connect, then add a remote directory.',
  sandboxHost: 'Host sandbox', sandboxRemote: 'Remote sandbox', sandboxSelected: 'Backend selected', sandboxUnavailable: 'Backend unavailable', sandboxError: 'Check failed',
  sandboxFull: 'Full enforcement', sandboxPartial: 'Partial enforcement', sandboxHint: 'Read-only backend preflight; commands still require runtime enforcement. Linux needs usable bubblewrap or Landlock; macOS needs sandbox-exec. Reconnect after repairing the remote; restart DSH after repairing the Host.',
  noWorkspaces: 'This server has no workspaces yet.', noSessions: 'This workspace has no conversations yet.',
  selectServer: 'Select server', selectedServer: 'Selected server', remotePath: 'Remote directory absolute path', title: 'Workspace name',
  addWorkspace: 'Add workspace', mount: 'Mount', unmount: 'Unmount', open: 'Open', newSession: 'New conversation',
  viewSessions: 'Conversations', archive: 'Archive', restore: 'Restore', showArchived: 'Show archived', running: 'Running',
  disconnectConfirm: 'Disconnecting affects this server’s workspaces and running commands. Continue?',
  unmountConfirm: 'Stop commands and editors using this workspace before unmounting. Continue?',
  deleteServerConfirm: 'Delete this server configuration? Remove its workspaces first. Remote files are kept.',
  deleteWorkspaceConfirm: 'Remove this workspace registration? Remote files and saved conversations are kept.',
  connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', mounted: 'Mounted', unmounted: 'Unmounted',
  mounting: 'Mounting', error: 'Error', ready: 'Ready', idle: 'Idle', unknown: 'Unknown',
  validationAlias: 'SSH aliases may contain letters, numbers, dots, underscores, @ and hyphens, and cannot start with a hyphen.',
  validationPath: 'Enter an absolute path without newlines or NUL.', validationHash: 'SHA-256 must contain 64 hexadecimal characters.',
  validationTunnels: 'Tunnels must be an array of objects with valid remotePort, host and port.',
  validationMap: 'Executable mapping must be a JSON object with nonempty string keys and values.',
  requestFailed: 'Request failed', invalidResponse: 'The server returned an invalid response.',
  mountRequired: 'Connect the server and mount this workspace first.', nativePending: 'Waiting for DSH workspace synchronization. Try again shortly.',
  authError: 'DSH authentication expired or the request was rejected. Refresh the page and sign in again.',
  selectedWorkspace: 'Selected workspace', mountPath: 'Host mount path', closeEditor: 'Close editor',
  serverCount: 'servers', workspaceCount: 'workspaces', helperHelp: 'Only for an existing Helper. New servers can use automatic installation.',
  status: 'Status', inspectDetails: 'Details', noSelection: 'Choose a workspace to view its conversations.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'ssh-workspaces': keyof typeof zh }
}

type T = TranslateNS<typeof NS>
interface Tunnel { remotePort: number; host: string; port: number }
interface Server {
  id: string; label: string; host: string; helper?: string; helperHash?: string; helperMode?: 'auto' | 'manual'
  launch?: { kind: 'executable' } | { kind: 'node-script'; node: string; bootstrapPath?: string; bootstrapHash?: string }
  setupPhase?: 'detecting' | 'preparing' | 'uploading' | 'verifying'
  sandboxChecks?: SandboxChecks
  status: string; error?: string; tunnels?: Tunnel[]; executableMap?: Record<string, string>; hostExecutables?: string[]
}
interface Workspace {
  id: string; serverId: string; remotePath: string; mountPath: string; title: string
  workspaceId?: WorkspaceId; status: string; error?: string
}
interface State { servers: Server[]; workspaces: Workspace[] }
interface Face {
  workspaces: IWorkspaces; sessions: ISessions
  openWorkspace(id: WorkspaceId): Promise<void>
  newSession(id: WorkspaceId): void
  openSession(id: SessionId): void
  archive(id: SessionId): Promise<void>
  restore(id: SessionId): Promise<void>
}
interface PageProps extends Face { t: T }

/** Browser-safe HTTP transport; every request uses the existing DSH login cookie. */
async function request(t: T, path: string, method = 'GET', body?: object, signal?: AbortSignal): Promise<unknown> {
  const base = new URL('api/ssh-workspaces', document.baseURI)
  const response = await fetch(`${base.href}${path}`, {
    method, credentials: 'same-origin', signal,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401 || response.status === 403) throw new Error(t('authError'))
  let payload: unknown
  try { payload = await response.json() } catch { throw new Error(`${t('invalidResponse')} HTTP ${response.status}`) }
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.message === 'string' ? payload.message
      : isRecord(payload) && typeof payload.error === 'string' ? payload.error : response.statusText
    throw new Error(`${t('requestFailed')} (${response.status}): ${detail}`)
  }
  return payload
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function validSandboxChecks(value: unknown): boolean {
  return isRecord(value) && ['host', 'remote'].every(key => {
    const check = value[key]
    return isRecord(check) && ['selected', 'unavailable', 'error'].includes(String(check.status)) && typeof check.message === 'string'
      && (check.backend === undefined || typeof check.backend === 'string')
      && (check.enforcement === undefined || check.enforcement === 'full' || check.enforcement === 'partial')
  })
}
function readState(value: unknown, t: T): State {
  if (!isRecord(value) || !Array.isArray(value.servers) || !Array.isArray(value.workspaces)) throw new Error(t('invalidResponse'))
  const servers = value.servers.map((row: unknown): Server => {
    if (!isRecord(row) || !['id', 'label', 'host', 'status'].every(k => typeof row[k] === 'string')
      || (row.launch !== undefined && (!isRecord(row.launch) || !['executable', 'node-script'].includes(String(row.launch.kind))
      || (row.launch.kind === 'node-script' && typeof row.launch.node !== 'string')))
      || (row.sandboxChecks !== undefined && !validSandboxChecks(row.sandboxChecks))) throw new Error(t('invalidResponse'))
    return row as object as Server
  })
  const workspaces = value.workspaces.map((row: unknown): Workspace => {
    if (!isRecord(row) || !['id', 'serverId', 'remotePath', 'mountPath', 'title', 'status'].every(k => typeof row[k] === 'string')
      || (row.workspaceId !== undefined && typeof row.workspaceId !== 'string')) throw new Error(t('invalidResponse'))
    return row as object as Workspace
  })
  return { servers, workspaces }
}

const s = {
  page: { padding: '28px clamp(16px, 3vw, 40px)', height: '100%', overflow: 'auto', boxSizing: 'border-box', color: 'var(--text-primary, #253248)', background: 'var(--bg-primary, #f8fafc)' },
  header: { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 22 },
  h1: { margin: '0 0 8px', fontSize: 25, fontWeight: 650, letterSpacing: '-.5px' },
  muted: { color: 'var(--text-secondary, #64748b)', fontSize: 13, lineHeight: 1.6, margin: '4px 0' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))', gap: 22, alignItems: 'start' },
  card: { background: 'var(--bg-secondary, #fff)', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 14, padding: 20, minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' },
  buttons: { display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' },
  button: { border: '1px solid var(--border-color, #d7dfe8)', borderRadius: 8, padding: '7px 11px', color: 'inherit', background: 'var(--bg-primary, #f8fafc)', cursor: 'pointer', fontSize: 13 },
  primary: { border: '1px solid #315ed7', borderRadius: 8, padding: '8px 13px', color: '#fff', background: '#315ed7', cursor: 'pointer', fontSize: 13 },
  input: { width: '100%', boxSizing: 'border-box', padding: '9px 11px', fontSize: 13, border: '1px solid var(--border-color, #d7dfe8)', borderRadius: 8, color: 'inherit', background: 'var(--bg-primary, #f8fafc)' },
  label: { display: 'block', fontSize: 13, fontWeight: 550, marginBottom: 6 },
  field: { marginTop: 14 },
  item: { border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 10, padding: 13, marginTop: 12 },
  code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere', margin: '7px 0', color: 'var(--text-secondary, #64748b)' },
  error: { padding: '11px 14px', border: '1px solid #f1b7b7', borderRadius: 9, background: '#fff1f1', color: '#9f2424', marginBottom: 16, overflowWrap: 'anywhere', fontSize: 13 },
  notice: { padding: '10px 14px', borderRadius: 9, background: '#edf6f1', color: '#246845', marginBottom: 16, fontSize: 13 },
  section: { fontSize: 16, margin: 0, fontWeight: 650 },
  badge: { padding: '3px 8px', borderRadius: 20, background: 'var(--bg-primary, #f1f5f9)', color: 'var(--text-secondary, #64748b)', fontSize: 11, whiteSpace: 'nowrap' },
} satisfies Record<string, CSSProperties>

function Button({ children, primary = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" {...props} style={{ ...(primary ? s.primary : s.button), opacity: props.disabled ? .5 : 1, ...props.style }}>{children}</button>
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <div style={s.field}><label style={s.label}>{label}{children}</label>{hint && <div style={s.muted}>{hint}</div>}</div>
}
function Badge({ status, t }: { status: string; t: T }) {
  const known = ['connected', 'disconnected', 'connecting', 'installing', 'mounted', 'unmounted', 'mounting', 'error', 'ready', 'idle'] as const
  const key = known.find(k => k === status)
  const healthy = status === 'connected' || status === 'mounted' || status === 'ready'
  return <span style={{ ...s.badge, ...(healthy ? { color: '#19704b', background: '#e5f4ec' } : {}) }}>{key ? t(key) : status || t('unknown')}</span>
}

function SandboxStatus({ checks, t }: { checks: SandboxChecks; t: T }) {
  return <div style={{ ...s.item, marginBottom: 12 }}>
    {(['host', 'remote'] as const).map(location => {
      const check = checks[location]
      return <div key={location} style={s.muted}>
        <strong>{t(location === 'host' ? 'sandboxHost' : 'sandboxRemote')}: </strong>
        <span style={{ color: check.status === 'selected' && check.enforcement === 'full' ? '#19704b' : '#a26013' }}>
          {t(check.status === 'selected' ? 'sandboxSelected' : check.status === 'unavailable' ? 'sandboxUnavailable' : 'sandboxError')}
          {check.backend && ` · ${check.backend}`}
          {check.enforcement && ` · ${t(check.enforcement === 'full' ? 'sandboxFull' : 'sandboxPartial')}`}
        </span>
        {check.status !== 'selected' && <details><summary>{t('inspectDetails')}</summary><p style={s.code}>{check.message}</p></details>}
      </div>
    })}
    <p style={s.muted}>{t('sandboxHint')}</p>
  </div>
}

function ServerEditor({ server, t, busy, save, close }: { server?: Server; t: T; busy: boolean; save(value: object): Promise<void>; close(): void }) {
  const [label, setLabel] = useState(server?.label ?? '')
  const [host, setHost] = useState(server?.host ?? '')
  const [helperMode, setHelperMode] = useState<'auto' | 'manual'>(server?.helperMode ?? (server?.helper ? 'manual' : 'auto'))
  const [configHosts, setConfigHosts] = useState<Array<{ host: string; source: string }>>([])
  const [configNotice, setConfigNotice] = useState('')
  const [configLoading, setConfigLoading] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    void request(t, '/ssh-config', 'GET', undefined, controller.signal).then(value => {
      if (!isRecord(value) || !Array.isArray(value.hosts) || !Array.isArray(value.warnings)
        || !value.hosts.every(row => isRecord(row) && typeof row.host === 'string' && typeof row.source === 'string')) throw new Error(t('invalidResponse'))
      setConfigHosts(value.hosts as Array<{ host: string; source: string }>)
      setConfigNotice(value.warnings.map(String).join(' · '))
    }).catch(reason => { if (!controller.signal.aborted) setConfigNotice(String(reason)) })
      .finally(() => { if (!controller.signal.aborted) setConfigLoading(false) })
    return () => controller.abort()
  }, [t])
  const [helper, setHelper] = useState(server?.helper ?? '')
  const [hash, setHash] = useState(server?.helperHash ?? '')
  const [kind, setKind] = useState<'executable' | 'node-script'>(server?.launch?.kind ?? 'executable')
  const [node, setNode] = useState(server?.launch?.kind === 'node-script' ? server.launch.node : '/usr/bin/node')
  const [bootstrapPath, setBootstrapPath] = useState(server?.launch?.kind === 'node-script' ? server.launch.bootstrapPath ?? '' : '')
  const [bootstrapHash, setBootstrapHash] = useState(server?.launch?.kind === 'node-script' ? server.launch.bootstrapHash ?? '' : '')
  const [tunnels, setTunnels] = useState(JSON.stringify(server?.tunnels ?? [], null, 2))
  const [map, setMap] = useState(JSON.stringify(server?.executableMap ?? {}, null, 2))
  const [hostExecutables, setHostExecutables] = useState(JSON.stringify(server?.hostExecutables ?? [], null, 2))
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host.trim())) throw new Error(t('validationAlias'))
      const absolute = (path: string) => path.startsWith('/') && !/[\r\n\0]/.test(path)
      if (helperMode === 'manual' && (!absolute(helper.trim()) || (kind === 'node-script' && !absolute(node.trim())))) throw new Error(t('validationPath'))
      if (helperMode === 'manual' && !/^[a-fA-F0-9]{64}$/.test(hash.trim())) throw new Error(t('validationHash'))
      const parsedTunnels: unknown = JSON.parse(tunnels)
      const port = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
      if (!Array.isArray(parsedTunnels) || !parsedTunnels.every((item: unknown) => isRecord(item) && port(item.remotePort) && Number(item.remotePort) >= 1024
        && typeof item.host === 'string' && ['127.0.0.1', 'localhost', '::1'].includes(item.host) && port(item.port))) throw new Error(t('validationTunnels'))
      const parsedMap: unknown = JSON.parse(map)
      if (!isRecord(parsedMap) || !Object.entries(parsedMap).every(([k, v]) => k.length > 0 && typeof v === 'string' && v.length > 0)) throw new Error(t('validationMap'))
      const parsedHostExecutables: unknown = JSON.parse(hostExecutables)
      if (!Array.isArray(parsedHostExecutables) || !parsedHostExecutables.every((value: unknown) => typeof value === 'string' && value.length > 0)) throw new Error(t('validationHostExecutables'))
      if (helperMode === 'manual' && kind === 'node-script' && Boolean(bootstrapPath.trim()) !== Boolean(bootstrapHash.trim())) throw new Error(t('validationBootstrap'))
      if (helperMode === 'manual' && kind === 'node-script' && bootstrapPath.trim() && (!absolute(bootstrapPath.trim()) || !/^[a-fA-F0-9]{64}$/.test(bootstrapHash.trim()))) throw new Error(t('validationBootstrap'))
      await save({ ...(server === undefined ? {} : { id: server.id }), label: label.trim() || host.trim(), host: host.trim(), helperMode,
        ...(helperMode === 'auto' ? {} : { helper: helper.trim(),
        helperHash: hash.trim().toLowerCase(), launch: kind === 'executable' ? { kind } : { kind, node: node.trim(),
          ...(bootstrapPath.trim() ? { bootstrapPath: bootstrapPath.trim(), bootstrapHash: bootstrapHash.trim().toLowerCase() } : {}) } }),
        tunnels: parsedTunnels, executableMap: parsedMap, hostExecutables: parsedHostExecutables })
      close()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  return <form onSubmit={event => { void submit(event) }} style={{ ...s.item, borderColor: '#8aa7f0' }}>
    <div style={s.row}><h3 style={s.section}>{t(server ? 'editServer' : 'addServer')}</h3><Button onClick={close} aria-label={t('closeEditor')} disabled={busy}>×</Button></div>
    <Field label={t('fromConfig')} hint={t('configHelp')}><select style={s.input} value={configHosts.some(item => item.host === host) ? host : ''}
      disabled={configLoading || busy} onChange={event => { const alias = event.target.value; setHost(alias); if (!label) setLabel(alias) }}>
      <option value="">{t(configLoading ? 'loading' : 'configPlaceholder')}</option>
      {configHosts.map(item => <option key={item.host} value={item.host}>{item.host}</option>)}
    </select></Field>
    {!configLoading && configHosts.length === 0 && <p style={s.muted}>{t('configEmpty')}</p>}
    {configNotice && <p role="status" style={s.muted}>{configNotice}</p>}
    <Field label={t('label')}><input style={s.input} value={label} onChange={e => setLabel(e.target.value)} /></Field>
    <Field label={t('host')} hint={t('hostHelp')}><input style={s.input} value={host} onChange={e => setHost(e.target.value)} required placeholder="gpu-server" /></Field>
    <Field label={t('helperMode')}><select style={s.input} value={helperMode} onChange={event => setHelperMode(event.target.value === 'manual' ? 'manual' : 'auto')}>
      <option value="auto">{t('autoHelper')}</option><option value="manual">{t('manualHelper')}</option>
    </select></Field>
    {helperMode === 'auto' && <p style={s.muted}>{t('autoHelp')}</p>}
    {helperMode === 'manual' && <><Field label={t('helper')} hint={t('helperHelp')}><input style={s.input} value={helper} onChange={e => setHelper(e.target.value)} required placeholder="/opt/dsh-ssh/helper" /></Field>
    <Field label={t('helperHash')}><input style={{ ...s.input, fontFamily: 'monospace' }} value={hash} onChange={e => setHash(e.target.value)} required minLength={64} maxLength={64} spellCheck={false} /></Field>
    <Field label={t('launch')}><select style={s.input} value={kind} onChange={e => setKind(e.target.value === 'node-script' ? 'node-script' : 'executable')}><option value="executable">{t('executable')}</option><option value="node-script">{t('nodeScript')}</option></select></Field>
    {kind === 'node-script' && <Field label={t('node')}><input style={s.input} value={node} onChange={e => setNode(e.target.value)} required /></Field>}</>}
    <details style={s.field}><summary style={{ cursor: 'pointer', fontSize: 13 }}>{t('advanced')}</summary>
      {helperMode === 'manual' && kind === 'node-script' && <><Field label={t('bootstrapPath')}><input style={s.input} value={bootstrapPath} onChange={event => setBootstrapPath(event.target.value)} /></Field>
        <Field label={t('bootstrapHash')}><input style={{ ...s.input, fontFamily: 'monospace' }} value={bootstrapHash} onChange={event => setBootstrapHash(event.target.value)} spellCheck={false} /></Field></>}
      <Field label={t('tunnels')} hint={t('tunnelsHelp')}><textarea style={{ ...s.input, minHeight: 90, fontFamily: 'monospace' }} value={tunnels} onChange={e => setTunnels(e.target.value)} spellCheck={false} /></Field>
      <Field label={t('executableMap')} hint={t('mapHelp')}><textarea style={{ ...s.input, minHeight: 75, fontFamily: 'monospace' }} value={map} onChange={e => setMap(e.target.value)} spellCheck={false} /></Field>
      <Field label={t('hostExecutables')} hint={t('hostExecutablesHelp')}><textarea style={{ ...s.input, minHeight: 70, fontFamily: 'monospace' }} value={hostExecutables} onChange={event => setHostExecutables(event.target.value)} spellCheck={false} /></Field>
    </details>
    {error && <div role="alert" style={{ ...s.error, marginTop: 12 }}>{error}</div>}
    <div style={{ ...s.buttons, marginTop: 16 }}><Button type="submit" primary disabled={busy}>{t(busy ? 'working' : 'save')}</Button><Button onClick={close} disabled={busy}>{t('cancel')}</Button></div>
  </form>
}

function Page(props: PageProps) {
  const { t } = props
  const [state, setState] = useState<State>({ servers: [], workspaces: [] })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedServer, setSelectedServer] = useState('')
  const [selectedWorkspace, setSelectedWorkspace] = useState('')
  const [editor, setEditor] = useState<Server | 'new' | null>(null)
  const [remotePath, setRemotePath] = useState('')
  const [title, setTitle] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const requestNumber = useRef(0)
  const busyRef = useRef(false)
  const subscribeWorkspaces = useCallback((listener: () => void) => props.workspaces.list.subscribe(listener), [props.workspaces])
  const readWorkspaces = useCallback(() => props.workspaces.list.getSnapshot(), [props.workspaces])
  const subscribeSessions = useCallback((listener: () => void) => props.sessions.list.subscribe(listener), [props.sessions])
  const readSessions = useCallback(() => props.sessions.list.getSnapshot(), [props.sessions])
  const nativeWorkspaces = useSyncExternalStore(subscribeWorkspaces, readWorkspaces)
  const nativeSessions = useSyncExternalStore(subscribeSessions, readSessions)
  const refresh = useCallback(async () => {
    const sequence = ++requestNumber.current
    const result = readState(await request(t, '', 'GET', undefined, lifetime.current?.signal), t)
    if (sequence === requestNumber.current && !lifetime.current?.signal.aborted) { setState(result); setLoaded(true) }
  }, [t])
  useEffect(() => {
    const abort = new AbortController(); lifetime.current = abort
    void refresh().catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(reason => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
    }, 4000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    if (!state.servers.some(server => server.id === selectedServer)) setSelectedServer(state.servers[0]?.id ?? '')
    if (!state.workspaces.some(workspace => workspace.id === selectedWorkspace)) setSelectedWorkspace('')
  }, [state, selectedServer, selectedWorkspace])
  const run = async (operation: () => Promise<void>, rethrow = false) => {
    if (busyRef.current) { if (rethrow) throw new Error(t('working')); return }
    busyRef.current = true; setBusy(true); setError(''); setNotice('')
    try { await operation() } catch (reason) {
      if (!lifetime.current?.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      if (rethrow) throw reason
    } finally { busyRef.current = false; if (!lifetime.current?.signal.aborted) setBusy(false) }
  }
  const mutate = async (path: string, method = 'POST', body?: object) => {
    await request(t, path, method, body, lifetime.current?.signal)
    await refresh(); setNotice(t(path.endsWith('/connect') ? 'connectionStarted' : 'saved'))
  }
  const act = (path: string, method = 'POST', body?: object) => { void run(() => mutate(path, method, body)) }
  const activeServer = state.servers.find(server => server.id === selectedServer)
  const visibleWorkspaces = state.workspaces.filter(workspace => workspace.serverId === selectedServer)
  const selected = state.workspaces.find(workspace => workspace.id === selectedWorkspace)
  const native = nativeWorkspaces.items.find(workspace => workspace.workspaceId === selected?.workspaceId)
  const conversationIds = native?.sessionIds ?? []
  const ids = conversationIds.filter(id => showArchived || !nativeWorkspaces.archivedSessionIds.includes(id))
  const isReady = (workspace: Workspace) => workspace.status === 'mounted' && workspace.workspaceId !== undefined
  const open = (workspace: Workspace, fresh = false) => {
    void run(async () => {
      if (!isReady(workspace) || workspace.workspaceId === undefined) throw new Error(t('mountRequired'))
      if (!nativeWorkspaces.items.some(item => item.workspaceId === workspace.workspaceId)) throw new Error(t('nativePending'))
      if (fresh) props.newSession(workspace.workspaceId)
      else await props.openWorkspace(workspace.workspaceId)
    })
  }
  const addWorkspace = (event: FormEvent) => {
    event.preventDefault()
    if (!remotePath.startsWith('/') || /[\r\n\0]/.test(remotePath)) { setError(t('validationPath')); return }
    void run(async () => { await mutate('/workspaces', 'POST', { serverId: selectedServer, remotePath, title: title.trim() || remotePath.split('/').filter(Boolean).at(-1) || remotePath }); setRemotePath(''); setTitle('') })
  }
  return <div style={s.page}>
    <div style={s.header}><div><h1 style={s.h1}>{t('panel')}</h1><p style={s.muted}>{t('subtitle')}</p>
      <div style={s.muted}>{state.servers.length} {t('serverCount')} · {state.workspaces.length} {t('workspaceCount')}</div></div>
      <Button onClick={() => { void run(refresh) }} disabled={busy}>{t(busy ? 'working' : 'refresh')}</Button></div>
    {error && <div role="alert" style={s.error}>{error}</div>}
    {notice && <div role="status" style={s.notice}>{notice}</div>}
    {!loaded && !error && <p style={s.muted}>{t('loading')}</p>}
    <div style={s.grid}>
      <section style={s.card} aria-label={t('servers')}>
        <div style={s.row}><h2 style={s.section}>{t('servers')}</h2><Button primary onClick={() => setEditor('new')} disabled={busy}>{t('addServer')}</Button></div>
        {editor && <ServerEditor key={editor === 'new' ? 'new' : editor.id} server={editor === 'new' ? undefined : editor} t={t} busy={busy}
          close={() => setEditor(null)} save={value => run(() => mutate('/servers', 'POST', value), true)} />}
        {loaded && state.servers.length === 0 && <p style={{ ...s.muted, marginTop: 18 }}>{t('noServers')}</p>}
        {state.servers.map(server => <article key={server.id} style={{ ...s.item, ...(selectedServer === server.id ? { borderColor: '#86a4ee', boxShadow: '0 0 0 1px #86a4ee' } : {}) }}>
          <div style={s.row}><button type="button" onClick={() => { setSelectedServer(server.id); setSelectedWorkspace('') }} aria-pressed={selectedServer === server.id}
            style={{ border: 0, padding: 0, color: 'inherit', font: 'inherit', fontWeight: 650, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}>{server.label}</button><Badge status={server.status} t={t} /></div>
          <p style={s.code}>{server.host}</p>
          {server.setupPhase && <p role="status" aria-live="polite" style={s.muted}>{t(server.setupPhase)}</p>}
          {server.error && <p role="alert" style={{ ...s.muted, color: '#b43c3c' }}>{server.error}</p>}
          {server.sandboxChecks && <SandboxStatus checks={server.sandboxChecks} t={t} />}
          <div style={s.buttons}>
            {server.status === 'connected' || server.status === 'ready' ? <Button disabled={busy} onClick={() => act(`/servers/${encodeURIComponent(server.id)}/disconnect`)}>{t('disconnect')}</Button>
              : <Button primary disabled={busy || ['connecting', 'installing'].includes(server.status)} onClick={() => act(`/servers/${encodeURIComponent(server.id)}/connect`)}>{t('connect')}</Button>}
            <Button disabled={busy || ['connecting', 'installing'].includes(server.status)} onClick={() => { void run(async () => {
              const result = await request(t, `/servers/${encodeURIComponent(server.id)}/probe`, 'POST', undefined, lifetime.current?.signal)
              if (!isRecord(result) || typeof result.message !== 'string') throw new Error(t('invalidResponse'))
              await refresh()
              if (result.ok === false) throw new Error(result.message)
              setNotice(result.message)
            }) }}>{t('probe')}</Button>
            <Button disabled={busy || ['connecting', 'installing', 'connected'].includes(server.status)} onClick={() => setEditor(server)}>{t('edit')}</Button>
            <Button disabled={busy || ['connecting', 'installing'].includes(server.status)} onClick={() => { if (window.confirm(t('deleteServerConfirm'))) act(`/servers/${encodeURIComponent(server.id)}`, 'DELETE') }}>{t('remove')}</Button>
          </div>
        </article>)}
      </section>
      <section style={s.card} aria-label={t('workspaces')}>
        <h2 style={s.section}>{t('workspaces')}</h2>
        <Field label={t('selectedServer')}><select style={s.input} value={selectedServer} onChange={event => { setSelectedServer(event.target.value); setSelectedWorkspace('') }}>
          {!selectedServer && <option value="">{t('selectServer')}</option>}{state.servers.map(server => <option key={server.id} value={server.id}>{server.label} ({server.host})</option>)}
        </select></Field>
        {activeServer && <form onSubmit={addWorkspace}>
          <Field label={t('remotePath')}><input style={s.input} placeholder="/data/projects/my-project" value={remotePath} onChange={event => setRemotePath(event.target.value)} required /></Field>
          <Field label={t('title')}><input style={s.input} value={title} onChange={event => setTitle(event.target.value)} /></Field>
          <Button type="submit" primary style={{ marginTop: 14 }} disabled={busy || !selectedServer}>{t('addWorkspace')}</Button>
        </form>}
        {activeServer && visibleWorkspaces.length === 0 && <p style={{ ...s.muted, marginTop: 16 }}>{t('noWorkspaces')}</p>}
        {visibleWorkspaces.map(workspace => <article key={workspace.id} style={{ ...s.item, ...(selectedWorkspace === workspace.id ? { borderColor: '#86a4ee' } : {}) }}>
          <div style={s.row}><strong>{workspace.title}</strong><Badge status={workspace.status} t={t} /></div>
          <p style={s.code}>{workspace.remotePath}</p>
          {workspace.error && <p role="alert" style={{ ...s.muted, color: '#b43c3c' }}>{workspace.error}</p>}
          <div style={s.buttons}>
            <Button primary disabled={busy || !isReady(workspace)} onClick={() => open(workspace)}>{t('open')}</Button>
            <Button disabled={busy || !isReady(workspace)} onClick={() => open(workspace, true)}>{t('newSession')}</Button>
            <Button onClick={() => setSelectedWorkspace(workspace.id)}>{t('viewSessions')}</Button>
            {workspace.status === 'mounted' ? <Button disabled={busy} onClick={() => act(`/workspaces/${encodeURIComponent(workspace.id)}/unmount`)}>{t('unmount')}</Button>
              : <Button disabled={busy || workspace.status === 'mounting'} onClick={() => act(`/workspaces/${encodeURIComponent(workspace.id)}/mount`)}>{t('mount')}</Button>}
            <Button disabled={busy} onClick={() => { if (window.confirm(t('deleteWorkspaceConfirm'))) act(`/workspaces/${encodeURIComponent(workspace.id)}`, 'DELETE') }}>{t('remove')}</Button>
          </div>
          <details style={{ marginTop: 9, fontSize: 12 }}><summary style={{ cursor: 'pointer', color: 'var(--text-secondary, #64748b)' }}>{t('inspectDetails')}</summary><p style={s.code}>{t('mountPath')}: {workspace.mountPath}</p></details>
        </article>)}
      </section>
    </div>
    <section style={{ ...s.card, marginTop: 22 }} aria-label={t('conversations')}>
      <div style={s.row}><div><h2 style={s.section}>{t('conversations')}</h2>{selected && <p style={s.muted}>{selected.title} · {selected.remotePath}</p>}</div>
        <label style={{ ...s.muted, display: 'flex', gap: 7, alignItems: 'center' }}><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />{t('showArchived')}</label></div>
      {!selected ? <p style={{ ...s.muted, marginTop: 16 }}>{t('noSelection')}</p> : ids.length === 0 ? <p style={{ ...s.muted, marginTop: 16 }}>{t('noSessions')}</p>
        : ids.map(id => {
          const session = nativeSessions.byId[id]
          const archived = nativeWorkspaces.archivedSessionIds.includes(id)
          return <div key={id} style={{ ...s.item, ...s.row }}><div style={{ minWidth: 0 }}><strong style={{ fontSize: 13 }}>{session?.displayTitle || id}</strong>
            {session?.running && <span style={{ ...s.badge, marginLeft: 8 }}>{t('running')}</span>}<div style={s.code}>{id}</div></div>
            <div style={s.buttons}><Button disabled={busy || archived} onClick={() => props.openSession(id)}>{t('open')}</Button>
              <Button disabled={busy || Boolean(session?.running)} onClick={() => { void run(() => archived ? props.restore(id) : props.archive(id)) }}>{t(archived ? 'restore' : 'archive')}</Button></div></div>
        })}
    </section>
  </div>
}

function Icon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M12 10v4M16 6.5h2M16 17.5h2" /></svg>
}

/** Services supplied by the stock Web profile. */
export const inject = ['slots', 'locale', 'layout', 'uiWorkspace', 'workspaces', 'sessions']

/** Add one native sidebar entry; disabling the plugin removes its panel and effects. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ssh-workspaces: locale')
  const t = ctx.locale.bind(NS)
  const face: Face = {
    // Host and Client compile together in this external package; select the published Client face.
    workspaces: ctx.workspaces, sessions: Reflect.get(ctx as object, 'sessions') as ISessions,
    openWorkspace: id => ctx.uiWorkspace.openWorkspace(id),
    newSession: id => ctx.uiWorkspace.startSession(id),
    openSession: id => ctx.uiWorkspace.openSession(id),
    archive: id => ctx.uiWorkspace.archiveSession(id),
    restore: id => ctx.uiWorkspace.unarchiveSession(id),
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => face }, Page))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, locale: NS, label: () => t('panel') }, Icon))
}
