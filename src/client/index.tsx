import type { ConnectionHandle, IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Config, SshAuthMode, SshServerConfig } from '../index.js'

const SETTINGS_NS = 'ssh-workspace'
const LOCALE_NS = 'settings.ssh-workspace'

type LocaleKey =
  | 'title' | 'description' | 'loading' | 'readOnly' | 'empty' | 'addServer'
  | 'serverName' | 'host' | 'port' | 'username' | 'root' | 'authMode'
  | 'authAuto' | 'authKey' | 'authPassword' | 'password' | 'passwordHint'
  | 'passwordSet' | 'passwordUnset' | 'privateKey' | 'privateKeyHint'
  | 'remoteRipgrep' | 'remoteRipgrepHint'
  | 'fingerprint' | 'fingerprintHint' | 'acceptUnknown' | 'workspaces'
  | 'workspacesHint' | 'remove' | 'confirmRemove' | 'cancel' | 'save'
  | 'saving' | 'discard' | 'saved' | 'saveFailed' | 'validationRequired'
  | 'validationPort' | 'validationRoot' | 'validationFingerprint' | 'validationPassword'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.ssh-workspace': LocaleKey
  }
}

const en: Record<LocaleKey, string> = {
  title: 'SSH workspaces',
  description: 'Configure multiple SSH servers and choose how each one authenticates.',
  loading: 'Loading SSH settings…',
  readOnly: 'This deployment stores settings read-only.',
  empty: 'No SSH servers are configured yet.',
  addServer: 'Add SSH server',
  serverName: 'Display name',
  host: 'Host',
  port: 'Port',
  username: 'Username',
  root: 'Remote root',
  authMode: 'Authentication',
  authAuto: 'Auto (key, agent, or password)',
  authKey: 'Private key / SSH agent',
  authPassword: 'Password only',
  password: 'Password',
  passwordHint: 'Write-only. Leave blank to keep the stored password.',
  passwordSet: 'A password is configured.',
  passwordUnset: 'No password is configured.',
  privateKey: 'Private key path',
  privateKeyHint: 'A local path on the DSH host. Blank uses SSH agent or common key files.',
  remoteRipgrep: 'Remote ripgrep executable',
  remoteRipgrepHint: 'Used by agent Glob/Grep tools. Blank resolves rg from the remote PATH.',
  fingerprint: 'Host key SHA256 fingerprint',
  fingerprintHint: 'Recommended: verify this through a trusted channel before connecting.',
  acceptUnknown: 'Allow an unverified host key (insecure)',
  workspaces: 'Startup workspaces',
  workspacesHint: 'One absolute remote directory per line. They are registered when DSH starts.',
  remove: 'Remove server',
  confirmRemove: 'Confirm removal',
  cancel: 'Cancel',
  save: 'Save SSH settings',
  saving: 'Saving…',
  discard: 'Discard changes',
  saved: 'SSH settings saved.',
  saveFailed: 'The settings could not be saved.',
  validationRequired: 'Name, host, username, and remote root are required.',
  validationPort: 'Port must be an integer from 1 to 65535.',
  validationRoot: 'Remote root and every workspace must be absolute paths.',
  validationFingerprint: 'Enter a host fingerprint or explicitly allow an unverified key.',
  validationPassword: 'Password-only authentication requires a stored or newly entered password.',
}

const zh: Record<LocaleKey, string> = {
  title: 'SSH 工作区',
  description: '配置多台 SSH 服务器，并为每台服务器选择登录方式。',
  loading: '正在加载 SSH 设置…',
  readOnly: '当前部署的设置为只读。',
  empty: '尚未配置 SSH 服务器。',
  addServer: '添加 SSH 服务器',
  serverName: '显示名称',
  host: '主机',
  port: '端口',
  username: '用户名',
  root: '远程根目录',
  authMode: '认证方式',
  authAuto: '自动（密钥、Agent 或密码）',
  authKey: '私钥 / SSH Agent',
  authPassword: '仅密码',
  password: '密码',
  passwordHint: '仅可写入。留空会保留已保存的密码。',
  passwordSet: '已配置密码。',
  passwordUnset: '尚未配置密码。',
  privateKey: '私钥路径',
  privateKeyHint: 'DSH 所在主机上的本地路径；留空会使用 SSH Agent 或常用密钥文件。',
  remoteRipgrep: '远端 ripgrep 可执行文件',
  remoteRipgrepHint: '供 agent 的 Glob/Grep 工具使用；留空会从远端 PATH 查找 rg。',
  fingerprint: '主机密钥 SHA256 指纹',
  fingerprintHint: '建议连接前通过可信渠道核对。',
  acceptUnknown: '允许未验证的主机密钥（不安全）',
  workspaces: '启动时注册的工作区',
  workspacesHint: '每行一个远程绝对目录；DSH 启动时自动注册。',
  remove: '删除服务器',
  confirmRemove: '确认删除',
  cancel: '取消',
  save: '保存 SSH 设置',
  saving: '保存中…',
  discard: '放弃修改',
  saved: 'SSH 设置已保存。',
  saveFailed: '无法保存设置。',
  validationRequired: '名称、主机、用户名和远程根目录不能为空。',
  validationPort: '端口必须是 1 到 65535 之间的整数。',
  validationRoot: '远程根目录和所有工作区都必须是绝对路径。',
  validationFingerprint: '请填写主机指纹，或明确允许未验证的密钥。',
  validationPassword: '仅密码认证必须已有保存的密码，或先输入一个新密码。',
}

interface SshSettingsFace {
  scope: SettingsScope<Config>
  api: Pick<IApiClient, 'credentials'>
}

type Props = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof LOCALE_NS>
  & InjectFace<SshSettingsFace>

type EditableServer = SshServerConfig & { port: number; authMode: SshAuthMode; workspaces: Array<{ path: string }> }

function copyServers(value: Config | undefined): EditableServer[] {
  return (value?.servers ?? []).map(server => ({
    ...server,
    port: server.port ?? 22,
    authMode: server.authMode ?? 'auto',
    workspaces: (server.workspaces ?? []).map(workspace => ({ path: workspace.path })),
  }))
}

function passwordRef(id: string): string {
  const suffix = id.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, '_')
  return `DSH_SSH_PASSWORD_${suffix}`
}

function newServer(): EditableServer {
  const id = `server-${globalThis.crypto.randomUUID().slice(0, 8)}`
  return {
    id,
    name: '',
    host: '',
    port: 22,
    username: '',
    root: '/',
    authMode: 'auto',
    acceptUnknownHostKey: false,
    workspaces: [],
  }
}

function validationError(
  servers: EditableServer[],
  credentialState: Record<string, boolean>,
  passwords: Record<string, string>,
  t: Props['t'],
): string | undefined {
  const ids = new Set<string>()
  for (const server of servers) {
    if ([server.name, server.host, server.username, server.root].some(value => value.trim().length === 0)) {
      return t('validationRequired')
    }
    if (ids.has(server.id)) return t('validationRequired')
    ids.add(server.id)
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) return t('validationPort')
    if (!server.root.startsWith('/') || server.workspaces.some(workspace => !workspace.path.startsWith('/'))) {
      return t('validationRoot')
    }
    if (!server.acceptUnknownHostKey && (server.hostKeySha256?.trim().length ?? 0) === 0) {
      return t('validationFingerprint')
    }
    if (server.authMode === 'password'
      && credentialState[server.id] !== true
      && (passwords[server.id]?.length ?? 0) === 0) {
      return t('validationPassword')
    }
  }
  return undefined
}

function cleanServers(servers: EditableServer[]): SshServerConfig[] {
  return servers.map((server) => {
    const { privateKeyPath, remoteRipgrepPath, hostKeySha256, passwordRef: storedPasswordRef, ...rest } = server
    const keyPath = privateKeyPath?.trim()
    const ripgrepPath = remoteRipgrepPath?.trim()
    const fingerprint = hostKeySha256?.trim()
    return {
      ...rest,
      name: server.name.trim(),
      host: server.host.trim(),
      username: server.username.trim(),
      root: server.root.trim(),
      ...(keyPath === undefined || keyPath.length === 0 ? {} : { privateKeyPath: keyPath }),
      ...(ripgrepPath === undefined || ripgrepPath.length === 0 ? {} : { remoteRipgrepPath: ripgrepPath }),
      ...(fingerprint === undefined || fingerprint.length === 0 ? {} : { hostKeySha256: fingerprint }),
      ...(storedPasswordRef === undefined ? {} : { passwordRef: storedPasswordRef }),
      workspaces: server.workspaces
        .map(workspace => ({ path: workspace.path.trim() }))
        .filter(workspace => workspace.path.length > 0),
    }
  })
}

function messageOf(response: unknown): string {
  try { return JSON.stringify(response) } catch { return String(response) }
}

function Field(props: {
  label: string
  hint?: string
  value: string | number
  type?: 'text' | 'number' | 'password'
  disabled: boolean
  testId: string
  onChange: (value: string) => void
}) {
  return (
    <label className="dsh-ssh-field">
      <span>{props.label}</span>
      <input
        data-testid={props.testId}
        type={props.type ?? 'text'}
        value={props.value}
        disabled={props.disabled}
        autoComplete={props.type === 'password' ? 'new-password' : 'off'}
        onChange={event => { props.onChange(event.currentTarget.value) }}
      />
      {props.hint === undefined ? null : <small>{props.hint}</small>}
    </label>
  )
}

export function SshSettingsCard(props: Props) {
  const snapshot = useSyncExternalStore(
    listener => props.scope.subscribe(listener),
    () => props.scope.getSnapshot(),
  )
  const [servers, setServers] = useState<EditableServer[]>(() => copyServers(snapshot.value))
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [credentialState, setCredentialState] = useState<Record<string, boolean>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'failed'>('idle')
  const [removing, setRemoving] = useState<string>()

  useEffect(() => {
    if (!dirty) setServers(copyServers(snapshot.value))
  }, [snapshot.value, dirty])

  const refs = useMemo(() => servers.map(server => server.passwordRef ?? passwordRef(server.id)), [servers])
  useEffect(() => {
    let active = true
    void props.api.credentials.describe({ refs }).then((response) => {
      if (!active || !response.result.ok) return
      const next: Record<string, boolean> = {}
      for (const server of servers) {
        const ref = server.passwordRef ?? passwordRef(server.id)
        next[server.id] = response.result.value.credentials[ref]?.configured ?? false
      }
      setCredentialState(next)
    }).catch(() => {})
    return () => { active = false }
  }, [props.api, refs.join('\n')])

  const disabled = !snapshot.writable || saving
  const error = validationError(servers, credentialState, passwords, props.t)
  const mutate = (id: string, patch: Partial<EditableServer>): void => {
    setServers(current => current.map(server => server.id === id ? { ...server, ...patch } : server))
    setDirty(true)
    setStatus('idle')
  }
  const discard = (): void => {
    setServers(copyServers(snapshot.value))
    setPasswords({})
    setDirty(false)
    setStatus('idle')
    setRemoving(undefined)
  }
  const save = async (): Promise<void> => {
    if (error !== undefined || !dirty || disabled) return
    setSaving(true)
    setStatus('idle')
    try {
      for (const server of servers) {
        const value = passwords[server.id]
        if (value === undefined || value.length === 0) continue
        const response = await props.api.credentials.set({
          ref: server.passwordRef ?? passwordRef(server.id),
          value,
        })
        if (!response.result.ok) throw new Error(messageOf(response.result.error))
      }
      const next = cleanServers(servers)
      await props.scope.set('servers', next)

      const retained = new Set(next.map(server => server.passwordRef ?? passwordRef(server.id)))
      const prior = copyServers(snapshot.value)
      for (const server of prior) {
        const ref = server.passwordRef ?? passwordRef(server.id)
        if (retained.has(ref)) continue
        const response = await props.api.credentials.unset({ ref })
        if (!response.result.ok) throw new Error(messageOf(response.result.error))
      }
      setCredentialState(current => {
        const updated = { ...current }
        for (const server of servers) {
          if ((passwords[server.id]?.length ?? 0) > 0) updated[server.id] = true
        }
        return updated
      })
      setPasswords({})
      setDirty(false)
      setStatus('saved')
    } catch {
      setStatus('failed')
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'loading') return <li className="dsh-ssh-card">{props.t('loading')}</li>
  if (snapshot.status === 'unavailable') return null

  return (
    <li className="dsh-ssh-card" data-testid="ssh-settings-card">
      <header>
        <div>
          <h3>{props.t('title')}</h3>
          <p>{props.t('description')}</p>
        </div>
        <button
          type="button"
          className="dsh-ssh-primary"
          data-testid="ssh-add-server"
          disabled={disabled}
          onClick={() => {
            setServers(current => [...current, newServer()])
            setDirty(true)
            setStatus('idle')
          }}
        >{props.t('addServer')}</button>
      </header>
      {!snapshot.writable ? <p role="status" className="dsh-ssh-warning">{props.t('readOnly')}</p> : null}
      {servers.length === 0 ? <p className="dsh-ssh-empty">{props.t('empty')}</p> : null}
      <div className="dsh-ssh-servers">
        {servers.map((server, index) => (
          <section className="dsh-ssh-server" data-testid={`ssh-server-${index}`} key={server.id}>
            <div className="dsh-ssh-server-heading">
              <strong>{server.name || `${props.t('title')} ${index + 1}`}</strong>
              {removing === server.id
                ? <div className="dsh-ssh-remove-actions">
                    <button type="button" disabled={disabled} onClick={() => { setRemoving(undefined) }}>{props.t('cancel')}</button>
                    <button
                      type="button"
                      className="dsh-ssh-danger"
                      data-testid={`ssh-confirm-remove-${index}`}
                      disabled={disabled}
                      onClick={() => {
                        setServers(current => current.filter(item => item.id !== server.id))
                        setRemoving(undefined)
                        setDirty(true)
                        setStatus('idle')
                      }}
                    >{props.t('confirmRemove')}</button>
                  </div>
                : <button
                    type="button"
                    data-testid={`ssh-remove-${index}`}
                    disabled={disabled}
                    onClick={() => { setRemoving(server.id) }}
                  >{props.t('remove')}</button>}
            </div>
            <div className="dsh-ssh-grid">
              <Field label={props.t('serverName')} value={server.name} disabled={disabled} testId={`ssh-name-${index}`} onChange={value => { mutate(server.id, { name: value }) }} />
              <Field label={props.t('host')} value={server.host} disabled={disabled} testId={`ssh-host-${index}`} onChange={value => { mutate(server.id, { host: value }) }} />
              <Field label={props.t('port')} value={server.port} type="number" disabled={disabled} testId={`ssh-port-${index}`} onChange={value => { mutate(server.id, { port: Number(value) }) }} />
              <Field label={props.t('username')} value={server.username} disabled={disabled} testId={`ssh-username-${index}`} onChange={value => { mutate(server.id, { username: value }) }} />
              <Field label={props.t('root')} value={server.root} disabled={disabled} testId={`ssh-root-${index}`} onChange={value => { mutate(server.id, { root: value }) }} />
              <label className="dsh-ssh-field">
                <span>{props.t('authMode')}</span>
                <select
                  data-testid={`ssh-auth-${index}`}
                  value={server.authMode}
                  disabled={disabled}
                  onChange={event => { mutate(server.id, { authMode: event.currentTarget.value as SshAuthMode }) }}
                >
                  <option value="auto">{props.t('authAuto')}</option>
                  <option value="key">{props.t('authKey')}</option>
                  <option value="password">{props.t('authPassword')}</option>
                </select>
              </label>
              {server.authMode === 'password' || server.authMode === 'auto'
                ? <Field
                    label={props.t('password')}
                    hint={`${props.t('passwordHint')} ${credentialState[server.id] === true ? props.t('passwordSet') : props.t('passwordUnset')}`}
                    value={passwords[server.id] ?? ''}
                    type="password"
                    disabled={disabled}
                    testId={`ssh-password-${index}`}
                    onChange={(value) => {
                      if (value.length > 0 && server.passwordRef === undefined) {
                        mutate(server.id, { passwordRef: passwordRef(server.id) })
                      }
                      setPasswords(current => ({ ...current, [server.id]: value }))
                      setDirty(true)
                      setStatus('idle')
                    }}
                  />
                : null}
              {server.authMode === 'key' || server.authMode === 'auto'
                ? <Field
                    label={props.t('privateKey')}
                    hint={props.t('privateKeyHint')}
                    value={server.privateKeyPath ?? ''}
                    disabled={disabled}
                    testId={`ssh-private-key-${index}`}
                    onChange={value => { mutate(server.id, { privateKeyPath: value }) }}
                  />
                : null}
              <Field
                label={props.t('remoteRipgrep')}
                hint={props.t('remoteRipgrepHint')}
                value={server.remoteRipgrepPath ?? ''}
                disabled={disabled}
                testId={`ssh-ripgrep-${index}`}
                onChange={value => { mutate(server.id, { remoteRipgrepPath: value }) }}
              />
              <Field
                label={props.t('fingerprint')}
                hint={props.t('fingerprintHint')}
                value={server.hostKeySha256 ?? ''}
                disabled={disabled || server.acceptUnknownHostKey === true}
                testId={`ssh-fingerprint-${index}`}
                onChange={value => { mutate(server.id, { hostKeySha256: value }) }}
              />
              <label className="dsh-ssh-check">
                <input
                  data-testid={`ssh-accept-unknown-${index}`}
                  type="checkbox"
                  checked={server.acceptUnknownHostKey ?? false}
                  disabled={disabled}
                  onChange={event => { mutate(server.id, { acceptUnknownHostKey: event.currentTarget.checked }) }}
                />
                <span>{props.t('acceptUnknown')}</span>
              </label>
              <label className="dsh-ssh-field dsh-ssh-wide">
                <span>{props.t('workspaces')}</span>
                <textarea
                  data-testid={`ssh-workspaces-${index}`}
                  value={server.workspaces.map(workspace => workspace.path).join('\n')}
                  disabled={disabled}
                  rows={3}
                  onChange={event => { mutate(server.id, { workspaces: event.currentTarget.value.split('\n').map(path => ({ path })) }) }}
                />
                <small>{props.t('workspacesHint')}</small>
              </label>
            </div>
          </section>
        ))}
      </div>
      {error === undefined ? null : <p role="alert" className="dsh-ssh-error">{error}</p>}
      {status === 'saved' ? <p role="status" className="dsh-ssh-success">{props.t('saved')}</p> : null}
      {status === 'failed' ? <p role="alert" className="dsh-ssh-error">{props.t('saveFailed')}</p> : null}
      <footer>
        <button type="button" disabled={!dirty || saving} onClick={discard}>{props.t('discard')}</button>
        <button
          type="button"
          className="dsh-ssh-primary"
          data-testid="ssh-save"
          disabled={!dirty || disabled || error !== undefined}
          onClick={() => { void save() }}
        >{props.t(saving ? 'saving' : 'save')}</button>
      </footer>
    </li>
  )
}

const css = `
.dsh-ssh-card{list-style:none;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:14px;padding:18px;margin:0;background:color-mix(in srgb,currentColor 3%,transparent)}
.dsh-ssh-card>header,.dsh-ssh-card>footer,.dsh-ssh-server-heading,.dsh-ssh-remove-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh-ssh-card h3{margin:0 0 4px;font-size:16px}.dsh-ssh-card p{margin:0;color:color-mix(in srgb,currentColor 68%,transparent);font-size:13px}.dsh-ssh-card button,.dsh-ssh-card input,.dsh-ssh-card select,.dsh-ssh-card textarea{font:inherit}.dsh-ssh-card button{border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:7px 11px;background:transparent;color:inherit;cursor:pointer}.dsh-ssh-card button:disabled{opacity:.45;cursor:not-allowed}.dsh-ssh-primary{background:#4b6bfb!important;border-color:#4b6bfb!important;color:#fff!important}.dsh-ssh-danger{background:#d83b3b!important;border-color:#d83b3b!important;color:#fff!important}.dsh-ssh-servers{display:grid;gap:12px;margin:16px 0}.dsh-ssh-server{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:12px;padding:14px}.dsh-ssh-server-heading{margin-bottom:12px}.dsh-ssh-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.dsh-ssh-field{display:flex;flex-direction:column;gap:5px;font-size:13px}.dsh-ssh-field>span,.dsh-ssh-check span{font-weight:600}.dsh-ssh-field input,.dsh-ssh-field select,.dsh-ssh-field textarea{box-sizing:border-box;width:100%;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;padding:8px 10px;background:color-mix(in srgb,currentColor 3%,transparent);color:inherit}.dsh-ssh-field small{font-size:11px;line-height:1.35;color:color-mix(in srgb,currentColor 60%,transparent)}.dsh-ssh-check{display:flex;align-items:center;gap:8px;font-size:13px}.dsh-ssh-wide{grid-column:1/-1}.dsh-ssh-card>footer{justify-content:flex-end;margin-top:14px}.dsh-ssh-empty,.dsh-ssh-warning,.dsh-ssh-error,.dsh-ssh-success{margin-top:14px!important}.dsh-ssh-error{color:#d83b3b!important}.dsh-ssh-success{color:#218a55!important}@media(max-width:720px){.dsh-ssh-grid{grid-template-columns:1fr}.dsh-ssh-card>header{align-items:flex-start;flex-direction:column}.dsh-ssh-wide{grid-column:auto}}
`

export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const scope = ctx.settingsScope.bind<Config>({ namespace: SETTINGS_NS })
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-ssh-workspace: settings dictionaries')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-ssh-workspace'
    style.textContent = css
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'dsh-ssh-workspace: settings styles')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: SETTINGS_NS,
    locale: LOCALE_NS,
    inject: () => ({ scope, api }),
  }, SshSettingsCard))
}
