import type { ActionContext, ActionResult } from './types'
import { handleRemove, handleOpenFolder } from './basic'
import { handleDelete } from './delete'
import { handleCopy, handleCopyUpdate, handleReleaseUpdate } from './copy'
import { handleMigrateToStandalone } from './migrate'
import { handleLaunch } from './launch'
import { handleDelegateToSource } from './delegate'

export type { ActionContext, ActionResult } from './types'
export { handleRemove, handleOpenFolder } from './basic'
export { handleDelete } from './delete'
export { handleCopy, handleCopyUpdate, handleReleaseUpdate } from './copy'
export { handleMigrateToStandalone } from './migrate'
export { handleLaunch } from './launch'
export { handleDelegateToSource } from './delegate'
export { withAbortableSessionAction } from './withAbortable'

/** Session-level action ids handled by `dispatchSessionAction` directly.
 *  Anything outside this set is delegated to the install's source plugin. */
const SESSION_ACTION_IDS = [
  'remove',
  'open-folder',
  'delete',
  'copy',
  'copy-update',
  'release-update',
  'migrate-to-standalone',
  'launch',
] as const

export type SessionActionId = (typeof SESSION_ACTION_IDS)[number]

const SESSION_ACTION_ID_SET: ReadonlySet<string> = new Set(SESSION_ACTION_IDS)

function isSessionActionId(id: string): id is SessionActionId {
  return SESSION_ACTION_ID_SET.has(id)
}

/** Internal: session-only switch. Exhaustive over `SessionActionId` so
 *  adding a new id to the union produces a TS error here until a `case`
 *  is added. The outer `dispatchSessionAction` routes any non-session id
 *  to `handleDelegateToSource`. */
function dispatchToSessionHandler(
  ctx: ActionContext,
  actionId: SessionActionId,
): Promise<ActionResult> {
  switch (actionId) {
    case 'remove': return handleRemove(ctx)
    case 'open-folder': return handleOpenFolder(ctx)
    case 'delete': return handleDelete(ctx)
    case 'copy': return handleCopy(ctx)
    case 'copy-update': return handleCopyUpdate(ctx)
    case 'release-update': return handleReleaseUpdate(ctx)
    case 'migrate-to-standalone': return handleMigrateToStandalone(ctx)
    case 'launch': return handleLaunch(ctx)
    default: {
      const _exhaustive: never = actionId
      throw new Error(`Unhandled session action: ${String(_exhaustive)}`)
    }
  }
}

/** Single dispatch point shared by the `run-action` IPC handler and the
 *  picker's `pickerRunBackgroundOp` path. Session-level action ids
 *  (`copy`, `copy-update`, `delete`, `release-update`, etc.) MUST land
 *  here rather than going straight to `handleDelegateToSource` — those
 *  ids live in the session-handler switch below, not in any individual
 *  source's `handleAction`. Source-specific ids (`update-comfyui`,
 *  `snapshot-restore`, …) fall through to the source. */
export async function dispatchSessionAction(
  ctx: ActionContext,
  actionId: string,
): Promise<ActionResult> {
  if (isSessionActionId(actionId)) {
    return dispatchToSessionHandler(ctx, actionId)
  }
  return handleDelegateToSource(ctx, actionId)
}
