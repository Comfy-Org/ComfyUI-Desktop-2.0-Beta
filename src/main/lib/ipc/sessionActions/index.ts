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
  switch (actionId) {
    case 'remove': return handleRemove(ctx)
    case 'open-folder': return handleOpenFolder(ctx)
    case 'delete': return handleDelete(ctx)
    case 'copy': return handleCopy(ctx)
    case 'copy-update': return handleCopyUpdate(ctx)
    case 'release-update': return handleReleaseUpdate(ctx)
    case 'migrate-to-standalone': return handleMigrateToStandalone(ctx)
    case 'launch': return handleLaunch(ctx)
    default: return handleDelegateToSource(ctx, actionId)
  }
}
