import type { ComposerTranslation } from 'vue-i18n'

// Raw main-process status strings mapped to friendlier UI copy.
const OP_STATUS_MAP: Record<string, string> = {
  'Fetching latest stable version': 'Checking for latest version…',
  'Fetching version tags…': 'Checking for latest version…',
  'Already up to date': 'Already up to date',
  'Up to date': 'Already up to date',
  'Stopping…': 'Stopping instance…',
  'Creating Python environment…': 'Setting up environment…',
  'Loading snapshot…': 'Loading snapshot…',
  Complete: 'Finishing up…',
}

type TLike = ComposerTranslation | ((key: string, fallback?: string) => string)

export function humanizeOpStatus(raw: string | null | undefined, t: TLike): string {
  const key = raw || ''
  if (key in OP_STATUS_MAP) return OP_STATUS_MAP[key]!
  if (key) return key
  return (t as (k: string, fb?: string) => string)('instancePicker.progressWorking', 'Working…')
}

export interface OperationLabelDescriptor {
  actionId: string
  actionData?: Record<string, unknown> | null
  title?: string
}

function isDowngrade(op: OperationLabelDescriptor): boolean {
  return (op.actionData as { isDowngrade?: boolean } | null | undefined)?.isDowngrade === true
}

/** In-flight progress title for a background op, keyed by `actionId`. */
export function operationInflightLabel(op: OperationLabelDescriptor, t: TLike): string {
  const tt = t as (k: string, fb?: string) => string
  switch (op.actionId) {
    case 'update-comfyui':
      return isDowngrade(op)
        ? tt('instancePicker.progressDowngrading', 'Downgrading…')
        : tt('instancePicker.progressUpdating', 'Updating…')
    case 'release-update':
      return tt('instancePicker.progressUpdating', 'Updating…')
    case 'copy':
      return tt('instancePicker.progressCopying', 'Copying…')
    case 'copy-update':
      return tt('instancePicker.progressCopyingUpdating', 'Copying & updating…')
    case 'delete':
      return tt('instancePicker.progressDeleting', 'Deleting…')
    case 'snapshot-restore':
      return tt('instancePicker.progressRestoring', 'Restoring snapshot…')
    case 'snapshot-save':
      return tt('instancePicker.progressSavingSnapshot', 'Saving snapshot…')
    case 'snapshot-delete':
      return tt('instancePicker.progressDeletingSnapshot', 'Deleting snapshot…')
    case 'migrate-to-standalone':
      return tt('instancePicker.progressMigrating', 'Migrating…')
    default:
      return op.title || tt('instancePicker.progressWorking', 'Working…')
  }
}

/** Success heading for a completed background op, keyed by `actionId`. */
export function operationSuccessLabel(op: OperationLabelDescriptor, t: TLike): string {
  const tt = t as (k: string, fb?: string) => string
  switch (op.actionId) {
    case 'update-comfyui':
      return isDowngrade(op)
        ? tt('instancePicker.progressDowngraded', 'Downgrade complete')
        : tt('instancePicker.progressSuccessStopped', 'Update complete')
    case 'release-update':
      return tt('instancePicker.progressSuccessStopped', 'Update complete')
    case 'copy':
      return tt('instancePicker.progressCopied', 'Copy complete')
    case 'copy-update':
      return tt('instancePicker.progressCopiedUpdated', 'Copy complete')
    case 'delete':
      return tt('instancePicker.progressDeleted', 'Deleted')
    case 'snapshot-restore':
      return tt('instancePicker.progressRestored', 'Snapshot restored')
    case 'snapshot-save':
      return tt('instancePicker.progressSnapshotSaved', 'Snapshot saved')
    case 'snapshot-delete':
      return tt('instancePicker.progressSnapshotDeleted', 'Snapshot deleted')
    case 'migrate-to-standalone':
      return tt('instancePicker.progressMigrated', 'Migration complete')
    default:
      return tt('instancePicker.progressDone', 'Done')
  }
}
