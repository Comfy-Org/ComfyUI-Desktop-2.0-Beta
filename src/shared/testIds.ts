/** Single source of truth for `data-testid` values, imported by both
 *  components and e2e tests (`e2e/support/testIds.ts`) so a rename is a
 *  typecheck failure rather than a silent selector miss. */

export const TID = {
  pickerRow: (installId: string) => `picker-row-${installId}`,
  pickerRowOpen: (installId: string) => `picker-row-open-${installId}`,
  pickerRowManage: (installId: string) => `picker-row-manage-${installId}`,
  pickerNewWindow: 'picker-new-window',
  pickerSettingsLoading: 'picker-settings-loading',
  pickerSettingsSections: 'picker-settings-sections',

  dashboardTile: (installId: string) => `dashboard-tile-${installId}`,
  dashboardTileKebab: (installId: string) => `dashboard-tile-kebab-${installId}`,

  /** A single item in the shared `ContextMenu`. `id` matches `ContextMenuItem.id`. */
  contextMenuItem: (id: string) => `context-menu-item-${id}`,

  modalConfirm: 'modal-confirm-button',
  modalCancel: 'modal-cancel-button',
  modalPromptInput: 'modal-prompt-input',
  baseAlertAction: 'base-alert-action',
  baseAlertCancel: 'base-alert-cancel',
  /** `BasePrompt` input (`useDialogs().prompt()`); distinct from the
   *  legacy `modalPromptInput` (`useModal().prompt()`). */
  basePromptInput: 'base-prompt-input',
  basePromptAction: 'base-prompt-action',
  basePromptCancel: 'base-prompt-cancel',
  deleteConfirmModal: 'delete-confirm-modal',
  deleteConfirmButton: 'delete-confirm-button',

  updateChannelCard: (channel: string) => `update-channel-card-${channel}`,
  updateActionButton: (actionId: string) => `update-action-${actionId}`,

  /** An action item in the Settings footer "More" menu. `actionId`
   *  matches the source's `ActionDef.id` (with Launch→Restart as `restart`). */
  pinBottomAction: (actionId: string) => `pin-bottom-action-${actionId}`,

  snapshotRow: (filename: string) => `snapshot-row-${filename}`,
  snapshotRowRestore: (filename: string) => `snapshot-row-restore-${filename}`,
  snapshotRowExport: (filename: string) => `snapshot-row-export-${filename}`,
  snapshotsImport: 'snapshots-import',
  snapshotsExportAll: 'snapshots-export-all',
  snapshotsOpCard: 'snapshots-op-card',
  snapshotsOpCardCancel: 'snapshots-op-card-cancel',
  snapshotsOpCardRetry: 'snapshots-op-card-retry',
  snapshotsOpCardDismiss: 'snapshots-op-card-dismiss',

  consoleTerminal: 'console-terminal',
  consoleSessionEnded: 'console-session-ended',
  consoleRestart: 'console-restart',

  progressErrorMessage: 'progress-error-message',
  progressLogs: 'progress-logs',
  progressReboot: 'progress-reboot',
  /** Rendered in place of the generic error banner when the op returned
   *  `result.portConflict`. */
  progressPortConflictBanner: 'progress-port-conflict-banner',
  /** Visible only when `portConflict.nextPort` is set. */
  progressPortConflictUsePort: 'progress-port-conflict-use-port',
  /** Visible only when `portConflict.isComfy` is true. */
  progressPortConflictKill: 'progress-port-conflict-kill',
} as const

export type TestIdKey = keyof typeof TID
