/**
 * Plugin styles. Every color resolves through a `--dsw-alias-*` token so the
 * light and dark themes both apply; classes are prefixed `sf-`.
 */

const CSS = `
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
`

const TAG = 'dsh-ssh-fleet/styles'

/** Install the stylesheet once per document; returns the remover. */
export function installStyles() {
  if (typeof document === 'undefined') return () => {}
  let tag = document.querySelector(`style[data-plugin-css="${TAG}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.setAttribute('data-plugin-css', TAG)
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  return () => tag?.remove()
}
