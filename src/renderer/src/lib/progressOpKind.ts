import type { ShowProgressOpts } from '../types/ipc'

export type ProgressOpKind = NonNullable<ShowProgressOpts['opKind']>

export function progressOpKindForActionId(actionId: string): ProgressOpKind {
  switch (actionId) {
    case 'launch':
    case 'restart':
      return 'launch'
    case 'delete':
      return 'destructive'
    case 'restore-snapshot':
      return 'snapshot'
    case 'release-update':
    case 'copy-update':
    case 'update':
      return 'update'
    default:
      if (actionId.startsWith('install')) return 'install'
      if (actionId.startsWith('snapshot')) return 'snapshot'
      if (actionId.includes('update')) return 'update'
      return 'generic'
  }
}

/** Whether the action id removes the install from the registry on
 *  success. Drives the `destroysInstance` carve-out on ShowProgressOpts
 *  (see the field doc for the full behaviour). */
export function destroysInstanceForActionId(actionId: string): boolean {
  return actionId === 'delete'
}
