import { _operationAborts, MSG_CANCELLED } from '../shared'
import type { ActionContext, ActionResult } from './types'

/**
 * Lifecycle wrapper for session-action handlers needing an AbortController
 * registered in `_operationAborts`. Inner handlers must re-throw after their
 * own rollback so this wrapper maps the error correctly.
 */
export async function withAbortableSessionAction(
  ctx: ActionContext,
  fn: (signal: AbortSignal, ctx: ActionContext) => Promise<ActionResult>,
): Promise<ActionResult> {
  if (_operationAborts.has(ctx.installationId)) {
    return { ok: false, message: 'Another operation is already running for this installation.' }
  }
  const abort = new AbortController()
  _operationAborts.set(ctx.installationId, abort)
  try {
    return await fn(abort.signal, ctx)
  } catch (err) {
    if (abort.signal.aborted) return { ok: false, cancelled: true, message: MSG_CANCELLED }
    return { ok: false, message: (err as Error).message }
  } finally {
    _operationAborts.delete(ctx.installationId)
  }
}
