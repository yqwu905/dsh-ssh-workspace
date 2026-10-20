/**
 * Occupant of ui-workspace's directory-flow holes ("Add workspace").
 *
 * Registered one priority below the composition's own picker (native or
 * browse), so it renders instead of it, and asks first where the directory
 * is: this computer, or one of the configured servers.
 * - This computer: the shadowed picker renders unchanged with the owner's
 *   props, so local picking behaves exactly as without this plugin.
 * - A server: the browse dialog is reused with its listing/creation calls
 *   pointed at the server (native compositions get RemoteBrowser), and the
 *   picked remote directory becomes a Workspace through the Host, which
 *   answers the anchor path the owner adopts.
 * Without configured servers the chooser is skipped entirely.
 */

import { createElement, useEffect, useRef, useState } from 'react'
import { IconFolderOpenRegular, IconGlobeOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { destinationOf } from './ServersSection.jsx'
import { RemoteBrowser } from './RemoteBrowser.jsx'

export function DirectoryFlow(props) {
  const { open, busy, onPicked, onCancel, onError, api, t, shadowed } = props
  // stage: 'closed' | 'loading' | 'choose' | 'local' | { host }
  const [stage, setStage] = useState('closed')
  const [hosts, setHosts] = useState([])
  const [adopting, setAdopting] = useState(false)
  const chooserShown = useRef(false)

  useEffect(() => {
    if (!open) {
      setStage('closed')
      chooserShown.current = false
      return
    }
    if (stage !== 'closed') return
    setStage('loading')
    api.hosts().then(
      (data) => {
        const list = data.hosts ?? []
        setHosts(list)
        chooserShown.current = list.length > 0
        setStage(list.length > 0 ? 'choose' : 'local')
      },
      () => {
        // The server list is an enhancement; local picking must keep working.
        chooserShown.current = false
        setStage('local')
      },
    )
  }, [open])

  if (!open || stage === 'closed' || stage === 'loading') return null

  const back = () => {
    if (chooserShown.current) setStage('choose')
    else onCancel()
  }

  if (stage === 'choose') {
    return (
      <Modal open onClose={onCancel} title={t('flow.title')} description={t('flow.description')} closeLabel={t('action.close')}>
        <ul className="sf-list" data-testid="ssh-fleet-location">
          <li>
            <button type="button" className="sf-option" onClick={() => setStage('local')} data-modal-autofocus="">
              <span className="sf-option-icon"><IconFolderOpenRegular size={20} /></span>
              <span className="sf-option-text">
                <span className="sf-option-title">{t('flow.local')}</span>
                <span className="sf-option-sub">{t('flow.localHint')}</span>
              </span>
            </button>
          </li>
          {hosts.map(host => (
            <li key={host.id}>
              <button type="button" className="sf-option" data-server={host.id} onClick={() => setStage({ host: host.id })}>
                <span className="sf-option-icon"><IconGlobeOutlineRegular size={20} /></span>
                <span className="sf-option-text">
                  <span className="sf-option-title">{host.id}</span>
                  <span className="sf-option-sub">{destinationOf(host)}{host.description ? ` · ${host.description}` : ''}</span>
                </span>
                <span className={`sf-dot sf-dot-${host.state?.status ?? 'idle'}`} />
              </button>
            </li>
          ))}
        </ul>
        <p className="sf-caption">{t('flow.manage')}</p>
      </Modal>
    )
  }

  const entry = shadowed()

  if (stage === 'local') {
    if (entry === undefined) {
      queueMicrotask(() => onError('no directory picker is available'))
      return null
    }
    return createElement(entry.component, {
      ...entry.face,
      open,
      busy,
      onPicked,
      onError,
      onCancel: back,
    })
  }

  // A server.
  const hostId = stage.host
  const host = hosts.find(h => h.id === hostId)
  const start = host?.workspace
  const listDirectory = (path, signal) => api.listDirectory(hostId, path ?? start, signal)
  const createDirectory = (path, name) => api.createDirectory(hostId, path, name)
  const adopt = async (remotePath) => {
    setAdopting(true)
    try {
      const workspace = await api.createWorkspace(hostId, remotePath)
      onPicked(workspace.path)
    } catch (cause) {
      onError(cause.message)
    } finally {
      setAdopting(false)
    }
  }
  if (entry !== undefined && typeof entry.face.listDirectory === 'function') {
    // The browse composition: same dialog, pointed at the server.
    const browseT = typeof entry.face.t === 'function'
      ? (key, params) => (key === 'browser.title' ? t('browser.title', { host: hostId }) : entry.face.t(key, params))
      : entry.face.t
    return createElement(entry.component, {
      ...entry.face,
      key: `remote:${hostId}`,
      t: browseT,
      listDirectory,
      createDirectory,
      open,
      busy: busy || adopting,
      onPicked: adopt,
      onError,
      onCancel: back,
    })
  }
  return (
    <RemoteBrowser
      key={hostId}
      hostId={hostId}
      listDirectory={listDirectory}
      createDirectory={createDirectory}
      busy={busy || adopting}
      t={t}
      onOpen={adopt}
      onClose={back}
    />
  )
}
