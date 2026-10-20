/** Settings → Servers: list, add, edit, test, remove and import SSH servers. */

import { useCallback, useEffect, useState } from 'react'
import {
  Button, Checkbox, IconEditOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
  IconTrashOutlineRegular, Input, Modal, SegmentedControl, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'

export function destinationOf(host) {
  return `${host.user ? `${host.user}@` : ''}${host.host}${host.port ? `:${host.port}` : ''}`
}

function StatusLine({ host, t }) {
  const status = host.state?.status ?? 'idle'
  const text = status === 'connected'
    ? t('state.connected', { os: host.state.os, arch: host.state.arch })
    : status === 'error' ? t('state.error') : t('state.idle')
  return (
    <span className="sf-status" title={host.state?.error ?? ''}>
      <span className={`sf-dot sf-dot-${status}`} />
      {text}
    </span>
  )
}

function testText(result, t) {
  if (result.ok) {
    const extras = `${result.bwrap ? t('test.bwrap') : ''}${result.rg ? t('test.rg') : ''}`
    return t('test.ok', { os: result.os, arch: result.arch, home: result.home, ms: String(result.latencyMs), extras })
  }
  return t('test.failed', { error: result.error })
}

const EMPTY = { id: '', host: '', user: '', port: '', identityFile: '', workspace: '', description: '', sshOptions: '', sandbox: 'auto', proxy: false }

function toForm(host) {
  return {
    ...EMPTY,
    ...host,
    port: host.port === undefined ? '' : String(host.port),
    sshOptions: (host.sshOptions ?? []).join('\n'),
    sandbox: host.sandbox ?? 'auto',
    proxy: host.proxy === true,
  }
}

function fromForm(form) {
  const host = { id: form.id.trim(), host: form.host.trim() }
  for (const key of ['user', 'identityFile', 'workspace', 'description']) if (form[key].trim() !== '') host[key] = form[key].trim()
  if (form.port.trim() !== '') host.port = Number(form.port)
  const options = form.sshOptions.split('\n').map(s => s.trim()).filter(Boolean)
  if (options.length > 0) host.sshOptions = options
  if (form.sandbox !== 'auto') host.sandbox = form.sandbox
  if (form.proxy) host.proxy = true
  return host
}

function Field({ label, hint, wide, children }) {
  return (
    <label className={`sf-field${wide ? ' sf-field-wide' : ''}`}>
      <span className="sf-label">{label}</span>
      {children}
      {hint ? <span className="sf-hint">{hint}</span> : null}
    </label>
  )
}

function HostEditor({ api, t, initial, creating, onClose, onSaved }) {
  const [form, setForm] = useState(() => toForm(initial ?? {}))
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState(undefined)
  const [saving, setSaving] = useState(false)
  const set = key => event => setForm(prev => ({ ...prev, [key]: event.target.value }))
  const test = async () => {
    setTesting(true)
    setResult(undefined)
    setError('')
    try {
      setResult(await api.test(fromForm(form)))
    } catch (cause) {
      setError(cause.message)
    } finally {
      setTesting(false)
    }
  }
  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.save(fromForm(form), creating)
      onSaved()
    } catch (cause) {
      setError(cause.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={creating ? t('editor.addTitle') : t('editor.editTitle', { id: initial.id })}
      description={t('editor.description')}
      className="sf-modal sf-modal-wide"
      closeLabel={t('action.close')}
      footer={(
        <div className="sf-footer">
          <Button variant="outline" onClick={test} disabled={testing || form.host.trim() === '' || form.id.trim() === ''}>
            {testing ? t('state.testing') : t('action.test')}
          </Button>
          <span className="sf-footer-spacer" />
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={saving || form.host.trim() === '' || form.id.trim() === ''}>{t('action.save')}</Button>
        </div>
      )}
    >
      <div className="sf-form">
        <Field label={t('field.id')} hint={creating ? t('field.idHint') : undefined}>
          <Input value={form.id} onChange={set('id')} disabled={!creating} placeholder="web1" data-modal-autofocus="" />
        </Field>
        <Field label={t('field.host')} hint={t('field.hostHint')}>
          <Input value={form.host} onChange={set('host')} placeholder="web1.example.com" />
        </Field>
        <Field label={t('field.user')}>
          <Input value={form.user} onChange={set('user')} placeholder="deploy" />
        </Field>
        <Field label={t('field.port')}>
          <Input value={form.port} onChange={set('port')} placeholder="22" inputMode="numeric" />
        </Field>
        <Field label={t('field.identityFile')}>
          <Input value={form.identityFile} onChange={set('identityFile')} placeholder="~/.ssh/id_ed25519" />
        </Field>
        <Field label={t('field.workspace')} hint={t('field.workspaceHint')}>
          <Input value={form.workspace} onChange={set('workspace')} placeholder="~/app" />
        </Field>
        <Field label={t('field.description')} wide>
          <Input value={form.description} onChange={set('description')} />
        </Field>
        <Field label={t('field.sshOptions')} hint={t('field.sshOptionsHint')} wide>
          <textarea className="sf-textarea" value={form.sshOptions} onChange={set('sshOptions')} spellCheck={false} />
        </Field>
        <div className="sf-field sf-field-wide">
          <span className="sf-label">{t('field.sandbox')}</span>
          <SegmentedControl
            className="sf-segmented"
            id="ssh-fleet-sandbox"
            label={t('field.sandbox')}
            value={form.sandbox}
            onChange={sandbox => setForm(prev => ({ ...prev, sandbox }))}
            options={[
              { value: 'auto', label: t('sandbox.auto') },
              { value: 'unconfined', label: t('sandbox.unconfined') },
              { value: 'refuse', label: t('sandbox.refuse') },
            ]}
          />
          <span className="sf-hint">{t(`sandbox.${form.sandbox}Hint`)}</span>
        </div>
        <div className="sf-switch-row sf-field-wide">
          <span className="sf-switch-text">
            <span className="sf-label">{t('field.proxy')}</span>
            <span className="sf-hint">{t('field.proxyHint')}</span>
          </span>
          <Switch checked={form.proxy} onChange={proxy => setForm(prev => ({ ...prev, proxy }))} label={t('field.proxy')} />
        </div>
      </div>
      {result ? <p className={`sf-result ${result.ok ? 'sf-result-ok' : 'sf-result-error'}`}>{testText(result, t)}</p> : null}
      {error ? <p className="sf-error">{error}</p> : null}
    </Modal>
  )
}

function ImportDialog({ api, t, onClose, onImported }) {
  const [path, setPath] = useState('~/.ssh/config')
  const [listing, setListing] = useState(undefined)
  const [selected, setSelected] = useState(() => new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async (configPath) => {
    setBusy(true)
    setError('')
    try {
      const result = await api.sshConfig(configPath === '~/.ssh/config' ? undefined : configPath)
      setListing(result)
      setSelected(new Set(result.candidates.filter(c => c.configuredAs === undefined).map(c => c.alias)))
    } catch (cause) {
      setError(cause.message)
    } finally {
      setBusy(false)
    }
  }, [api])
  useEffect(() => { void load('~/.ssh/config') }, [load])
  const toggle = (alias, on) => setSelected((prev) => {
    const next = new Set(prev)
    if (on) next.add(alias)
    else next.delete(alias)
    return next
  })
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await api.importSshConfig([...selected], path === '~/.ssh/config' ? undefined : path)
      onImported()
    } catch (cause) {
      setError(cause.message)
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('import.title')}
      description={t('import.description')}
      className="sf-modal sf-modal-wide"
      closeLabel={t('action.close')}
      footer={(
        <div className="sf-footer">
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || selected.size === 0}>
            {t('action.importSelected', { count: String(selected.size) })}
          </Button>
        </div>
      )}
    >
      <div className="sf-inline">
        <Input value={path} onChange={event => setPath(event.target.value)} aria-label={t('import.path')} />
        <Button variant="outline" onClick={() => load(path)} disabled={busy}>{t('action.load')}</Button>
      </div>
      {listing && listing.candidates.length === 0 ? <p className="sf-caption">{t('import.none')}</p> : null}
      {listing && listing.candidates.length > 0 ? (
        <ul className="sf-list">
          {listing.candidates.map(candidate => (
            <li key={candidate.alias} className="sf-import-row">
              <Checkbox
                checked={selected.has(candidate.alias)}
                disabled={candidate.configuredAs !== undefined}
                onChange={on => toggle(candidate.alias, on)}
                label={candidate.alias}
              />
              <span className="sf-import-meta">
                {candidate.configuredAs !== undefined
                  ? t('import.configured', { id: candidate.configuredAs })
                  : `${candidate.user ? `${candidate.user}@` : ''}${candidate.hostname ?? candidate.alias}${candidate.port && candidate.port !== 22 ? `:${candidate.port}` : ''}${candidate.proxyJump ? ` via ${candidate.proxyJump}` : ''}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="sf-error">{error}</p> : null}
    </Modal>
  )
}

export function ServersSection({ api, t }) {
  const [data, setData] = useState(undefined)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(undefined)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState(undefined)
  const [tests, setTests] = useState({})
  const refresh = useCallback(async () => {
    try {
      setData(await api.hosts())
      setError('')
    } catch (cause) {
      setError(cause.message)
    }
  }, [api])
  useEffect(() => { void refresh() }, [refresh])
  const test = async (host) => {
    setTests(prev => ({ ...prev, [host.id]: 'testing' }))
    try {
      const result = await api.test(fromForm(toForm(host)))
      setTests(prev => ({ ...prev, [host.id]: result }))
    } catch (cause) {
      setTests(prev => ({ ...prev, [host.id]: { ok: false, error: cause.message } }))
    }
    void refresh()
  }
  const confirmRemove = async () => {
    try {
      await api.remove(removing.id)
      setRemoving(undefined)
      void refresh()
    } catch (cause) {
      setError(cause.message)
      setRemoving(undefined)
    }
  }
  const hosts = data?.hosts ?? []
  return (
    <section className="sf-section" data-testid="ssh-fleet-servers">
      <h2 className="sf-title">{t('section.title')}</h2>
      <p className="sf-intro">{t('section.intro')}</p>
      <div className="sf-actions">
        <Button variant="primary" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setEditing({ creating: true, host: undefined })}>{t('action.add')}</Button>
        <Button variant="outline" onClick={() => setImporting(true)}>{t('action.import')}</Button>
        <Button variant="ghost" icon={<IconRefreshOutlineRegular size={16} />} onClick={refresh}>{t('action.refresh')}</Button>
      </div>
      {data?.hostsFile ? <p className="sf-caption">{t('section.file', { path: data.hostsFile })}</p> : null}
      {error ? <p className="sf-error">{error}</p> : null}
      {data && hosts.length === 0 ? <p className="sf-caption">{t('section.empty')}</p> : null}
      <ul className="sf-rows">
        {hosts.map((host) => {
          const result = tests[host.id]
          const readonly = host.source === 'config'
          return (
            <li key={host.id} className="sf-card" data-server={host.id}>
              <div className="sf-card-head">
                <div className="sf-card-identity">
                  <span className="sf-card-name">
                    {host.id}
                    {readonly ? <Tag>{t('tag.readonly')}</Tag> : null}
                  </span>
                  <span className="sf-card-dest">{destinationOf(host)}{host.workspace ? `  ·  ${host.workspace}` : ''}</span>
                  {host.description ? <span className="sf-caption">{host.description}</span> : null}
                </div>
                <StatusLine host={host} t={t} />
                <div className="sf-card-buttons">
                  <Button variant="outline" size="sm" onClick={() => test(host)} disabled={result === 'testing'}>
                    {result === 'testing' ? t('state.testing') : t('action.test')}
                  </Button>
                  {readonly ? null : (
                    <>
                      <Button variant="ghost" size="sm" icon={<IconEditOutlineRegular size={16} />} aria-label={t('action.edit')} title={t('action.edit')} onClick={() => setEditing({ creating: false, host })} />
                      <Button variant="ghost" size="sm" icon={<IconTrashOutlineRegular size={16} />} aria-label={t('action.remove')} title={t('action.remove')} onClick={() => setRemoving(host)} />
                    </>
                  )}
                </div>
              </div>
              {result !== undefined && result !== 'testing'
                ? <p className={`sf-result ${result.ok ? 'sf-result-ok' : 'sf-result-error'}`}>{testText(result, t)}</p>
                : null}
            </li>
          )
        })}
      </ul>
      {editing ? (
        <HostEditor
          api={api}
          t={t}
          initial={editing.host}
          creating={editing.creating}
          onClose={() => setEditing(undefined)}
          onSaved={() => { setEditing(undefined); void refresh() }}
        />
      ) : null}
      {importing ? (
        <ImportDialog api={api} t={t} onClose={() => setImporting(false)} onImported={() => { setImporting(false); void refresh() }} />
      ) : null}
      {removing ? (
        <Modal
          open
          onClose={() => setRemoving(undefined)}
          title={t('remove.title', { id: removing.id })}
          description={t('remove.body')}
          closeLabel={t('action.close')}
          footer={(
            <div className="sf-footer">
              <Button variant="ghost" onClick={() => setRemoving(undefined)}>{t('action.cancel')}</Button>
              <Button variant="primary" onClick={confirmRemove}>{t('action.remove')}</Button>
            </div>
          )}
        />
      ) : null}
    </section>
  )
}
