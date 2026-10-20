/**
 * In-app directory browser for one server, used when the composition's own
 * picker is the native OS chooser (which cannot browse a server). The browse
 * composition reuses the shipped dialog instead (see DirectoryFlow).
 */

import { useEffect, useState } from 'react'
import {
  Button, Checkbox, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconPlusOutlineRegular, Input, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'

export function RemoteBrowser({ hostId, listDirectory, createDirectory, busy, t, onOpen, onClose }) {
  const [listing, setListing] = useState(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pathDraft, setPathDraft] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const [folderName, setFolderName] = useState('')

  const load = async (path) => {
    setLoading(true)
    setError('')
    try {
      const next = await listDirectory(path)
      setListing(next)
      setPathDraft(next.path)
    } catch (cause) {
      setError(cause.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load(undefined) }, [hostId])

  const create = async () => {
    if (listing === undefined || folderName.trim() === '') return
    try {
      const created = await createDirectory(listing.path, folderName.trim())
      setCreating(false)
      setFolderName('')
      await load(created)
    } catch (cause) {
      setError(cause.message)
    }
  }

  const entries = (listing?.entries ?? []).filter(entry => showHidden || !entry.hidden)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('browser.title', { host: hostId })}
      closeLabel={t('action.close')}
      footer={(
        <div className="sf-footer">
          <Checkbox checked={showHidden} onChange={setShowHidden} label={t('browser.showHidden')} />
          <span className="sf-footer-spacer" />
          <Button variant="outline" icon={<IconPlusOutlineRegular size={16} />} onClick={() => setCreating(true)} disabled={listing === undefined}>{t('browser.newFolder')}</Button>
          <Button variant="ghost" onClick={onClose}>{t('action.cancel')}</Button>
          <Button variant="primary" onClick={() => listing && onOpen(listing.path)} disabled={busy || listing === undefined || listing.path === '/'}>
            {t('browser.open')}
          </Button>
        </div>
      )}
    >
      <form className="sf-inline" onSubmit={(event) => { event.preventDefault(); void load(pathDraft) }}>
        <Input value={pathDraft} onChange={event => setPathDraft(event.target.value)} aria-label={t('browser.path')} spellCheck={false} />
        <Button variant="outline" type="submit">{t('browser.go')}</Button>
      </form>
      {listing ? (
        <nav className="sf-crumbs" aria-label={t('browser.path')}>
          {listing.crumbs.map((crumb, index) => (
            <span key={crumb.path} className="sf-inline">
              {index > 1 ? <IconChevronRightOutlineRegular size={12} /> : null}
              <button
                type="button"
                className={`sf-crumb${index === listing.crumbs.length - 1 ? ' sf-crumb-current' : ''}`}
                onClick={() => load(crumb.path)}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>
      ) : null}
      {creating ? (
        <form className="sf-inline" onSubmit={(event) => { event.preventDefault(); void create() }}>
          <Input value={folderName} onChange={event => setFolderName(event.target.value)} placeholder={t('browser.folderName')} data-modal-autofocus="" />
          <Button variant="primary" type="submit" disabled={folderName.trim() === ''}>{t('browser.create')}</Button>
          <Button variant="ghost" type="button" onClick={() => setCreating(false)}>{t('action.cancel')}</Button>
        </form>
      ) : null}
      <ul className="sf-browser-list">
        {loading ? <li className="sf-busy">{t('browser.loading')}</li> : null}
        {!loading && entries.length === 0 && !error ? <li className="sf-busy">{t('browser.empty')}</li> : null}
        {!loading && entries.map(entry => (
          <li key={entry.path}>
            <button type="button" className={`sf-browser-row${entry.hidden ? ' sf-browser-row-hidden' : ''}`} onClick={() => load(entry.path)}>
              <IconFolderCloseRegular size={16} />
              {entry.name}
            </button>
          </li>
        ))}
      </ul>
      {listing?.truncated ? <p className="sf-caption">{t('browser.truncated')}</p> : null}
      {error ? <p className="sf-error">{error}</p> : null}
    </Modal>
  )
}
