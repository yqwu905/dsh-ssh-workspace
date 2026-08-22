import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from './index.js'

/** Route native-open requests for SSH anchors through a local read-only snapshot. */
export default class SshOpenPath extends Service {
  static inject = ['apiProxy', 'sshWorkspace']

  constructor(ctx: Context) {
    super(ctx, 'sshOpenPath')
    const original = ctx.apiProxy.host.openPath
    const wrapped: typeof original = async (request, signal) => {
      const routed = ctx.sshWorkspace.resolveAnchoredPath(request.payload.path)
      if (routed === undefined) return await original(request, signal)
      try {
        const path = await routed.server.materializeOpenPath(routed.remotePath, signal)
        return await original({ ...request, payload: { path } }, signal)
      } catch (error: unknown) {
        return {
          rpcId: request.rpcId,
          result: {
            ok: false,
            error: {
              code: signal.aborted ? 'cancelled' : 'internal',
              message: signal.aborted
                ? 'path open was aborted'
                : `SSH remote file preview failed: ${error instanceof Error ? error.message : String(error)}`,
              details: {},
            },
          },
        }
      }
    }
    ctx.apiProxy.host.openPath = wrapped
    ctx.effect(() => () => {
      if (ctx.apiProxy.host.openPath === wrapped) ctx.apiProxy.host.openPath = original
    }, 'restore native path opener')
  }
}
