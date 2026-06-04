import type { ActionContext, ActionResult } from './types'
import { handleRemove, handleOpenFolder, handleRename } from './basic'
import { handleDelete } from './delete'
import { handleCopy, handleCopyUpdate, handleReleaseUpdate } from './copy'
import { handleMigrateToStandalone } from './migrate'
import { handleLaunch } from './launch'
import { handleDelegateToSource } from './delegate'

export type { ActionContext, ActionResult } from './types'
export { handleRemove, handleOpenFolder, handleRename } from './basic'
export { handleDelete } from './delete'
export { handleCopy, handleCopyUpdate, handleReleaseUpdate } from './copy'
export { handleMigrateToStandalone } from './migrate'
export { handleLaunch } from './launch'
export { handleDelegateToSource } from './delegate'
export { withAbortableSessionAction } from './withAbortable'

// Action ids handled directly here; anything else delegates to the source plugin.
const SESSION_ACTION_IDS = [
  'remove',
  'rename',
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

// Exhaustive over SessionActionId so a new union member fails to compile here.
function dispatchToSessionHandler(
  ctx: ActionContext,
  actionId: SessionActionId,
): Promise<ActionResult> {
  switch (actionId) {
    case 'remove': return handleRemove(ctx)
    case 'rename': return handleRename(ctx)
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

// Single dispatch point for run-action and the picker's background-op path:
// session ids route to the switch above, everything else to the source.
export async function dispatchSessionAction(
  ctx: ActionContext,
  actionId: string,
): Promise<ActionResult> {
  if (isSessionActionId(actionId)) {
    return dispatchToSessionHandler(ctx, actionId)
  }
  return handleDelegateToSource(ctx, actionId)
}
