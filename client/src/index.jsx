/**
 * Browser half of dsh-ssh-fleet: Settings → Servers, and a location step in
 * front of the "Add workspace" directory flow.
 */

import { fleetApi } from './api.js'
import { DirectoryFlow } from './DirectoryFlow.jsx'
import { en, NS, zh } from './i18n.js'
import { ServersSection } from './ServersSection.jsx'
import { installStyles } from './styles.js'

/** The two directory-flow holes declared by ui-workspace. */
const HOLES = ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']

export const inject = ['slots', 'locale']

export function apply(ctx) {
  ctx.effect(() => installStyles(), 'dsh-ssh-fleet: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ssh-fleet: copy dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ssh-fleet',
    order: 45,
    label: () => t('nav'),
    inject: () => ({ api: fleetApi, t }),
  }, ServersSection))

  // The composition's own picker (native or browse) keeps its registration at
  // the default priority; this occupant shadows it from one priority lower and
  // renders it for local picks.
  const shadowedOf = hole => () => {
    const candidates = ctx.slots.entries(hole)
      .filter(entry => entry.component !== DirectoryFlow)
      .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
    const entry = candidates[0]
    return entry === undefined ? undefined : { component: entry.component, face: entry.inject ? entry.inject() : {} }
  }
  ctx.slots.inject(HOLES[0], () => ctx.slots.inject(HOLES[1], function* () {
    for (const hole of HOLES) {
      yield ctx.slots.register({
        name: hole,
        priority: -1,
        inject: () => ({ api: fleetApi, t, shadowed: shadowedOf(hole) }),
      }, DirectoryFlow)
    }
  }))
}
