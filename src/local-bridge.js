/**
 * Mounted inside the isolated group that holds the original local providers;
 * republishes them at the root as `ctx.sshFleetLocal` for the routers.
 * @module dsh-ssh-fleet/local-bridge
 */

import { Service } from '@deepseek-ai/cordis'

export default class LocalBridge extends Service {
  static inject = ['fs', 'subprocess', 'sandbox']

  /** @param {import('@deepseek-ai/cordis').Context} ctx */
  constructor(ctx) {
    super(ctx, 'sshFleetLocal')
    // Capture now: inside this group these names resolve to the local
    // providers; at the root they resolve to the routers.
    this.fs = ctx.fs
    this.subprocess = ctx.subprocess
    this.sandbox = ctx.sandbox
  }
}
