import { _operationAborts, MSG_CANCELLED } from '../shared'
import type { ActionContext, ActionResult } from './types'

/**
 * Shared lifecycle wrapper for session-action handlers that need an
 * AbortController registered in `_operationAborts`. Centralizes the
 * preconditions, controller registration, map cleanup, and the
 * `aborted` → `{ cancelled: true, message: MSG_CANCELLED }` mapping
 * so the writer string and the renderer's match string can't drift.
 *
 * Inner handlers receive a live `AbortSignal` plus the original ctx
 * and just return their success `ActionResult` (or throw on failure).
 * Rollback that must run on any error (e.g. release-update install
 * cleanup, delete marker restore) lives inside the inner function's
 * own try/catch — re-throw after cleanup so this wrapper maps the
 * error correctly.
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
