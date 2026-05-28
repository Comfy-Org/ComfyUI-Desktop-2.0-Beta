/**
 * Single source of truth for `data-testid` values used by e2e tests.
 *
 * Production Vue components import from this module instead of typing
 * literal strings, and e2e tests import the SAME constants via
 * `e2e/support/testIds.ts`. Renaming an id is a typecheck failure in
 * tests, not a silent selector miss.
 *
 * Naming convention: kebab-case, scoped by surface (e.g.
 * `picker-row-<id>`, `progress-error-message`). Per-instance variants
 * are functions that take the install id so the id stays a literal
 * type at the call site.
 */

export const TID = {
  // ---------- Title-popup instance picker ----------
  /** A row in the picker's instance list. One per install + cloud. */
  pickerRow: (installId: string) => `picker-row-${installId}`,
  /** The picker's compact-mode per-row Open button. */
  pickerRowOpen: (installId: string) => `picker-row-open-${installId}`,
  /** The picker's compact-mode per-row Manage button (expands the popup). */
  pickerRowManage: (installId: string) => `picker-row-manage-${installId}`,
  /** New-window CTA (compact + expanded). */
  pickerNewWindow: 'picker-new-window',
  /** Embedded ComfyUISettingsContent's loading placeholder. */
  pickerSettingsLoading: 'picker-settings-loading',
  /** Embedded ComfyUISettingsContent's settings sections root. */
  pickerSettingsSections: 'picker-settings-sections',

  // ---------- Dashboard / chooser ----------
  /** A dashboard install tile. */
  dashboardTile: (installId: string) => `dashboard-tile-${installId}`,
  /** The kebab / more-actions button on a dashboard tile. */
  dashboardTileKebab: (installId: string) => `dashboard-tile-kebab-${installId}`,

  // ---------- Context menu ----------
  /** A single item in the shared `ContextMenu` (the kebab + right-click
   *  menu). `id` matches the `ContextMenuItem.id` the composable emits
   *  — see `InstallMenuActionId` in `useInstallContextMenu.ts` for the
   *  install-menu variants. */
  contextMenuItem: (id: string) => `context-menu-item-${id}`,

  // ---------- Confirm modals ----------
  /** Generic confirm modal confirm button. Used by the rich-confirm
   *  (`messageDetails`, snapshot preview, etc.) variant of `ModalDialog`
   *  AND its prompt mode (e.g. Copy Installation new-name prompt). */
  modalConfirm: 'modal-confirm-button',
  /** Generic confirm modal cancel button. */
  modalCancel: 'modal-cancel-button',
  /** The text input inside the prompt modal (Copy Installation,
   *  Copy & Update, snapshot save label, etc.). */
  modalPromptInput: 'modal-prompt-input',
  /** The primary action button of a `BaseAlert` (alert OK / simple
   *  confirm primary). Hard-coded in `BaseAlert.vue` — kept here so
   *  tests reference a single source of truth. */
  baseAlertAction: 'base-alert-action',
  /** The cancel button of a simple-confirm `BaseAlert`. */
  baseAlertCancel: 'base-alert-cancel',
  /** The text input inside a `BasePrompt` (the `useDialogs().prompt()`
   *  surface — used by the picker's per-action prompts: Copy Installation
   *  name, Copy & Update name, etc.). Distinct from `modalPromptInput`
   *  which is the legacy `useModal().prompt()` `ModalDialog` surface. */
  basePromptInput: 'base-prompt-input',
  /** The primary action button of a `BasePrompt`. */
  basePromptAction: 'base-prompt-action',
  /** The cancel button of a `BasePrompt`. */
  basePromptCancel: 'base-prompt-cancel',
  /** Delete-install confirmation modal (the whole modal, for visibility waits). */
  deleteConfirmModal: 'delete-confirm-modal',
  /** Delete-install confirmation confirm button. */
  deleteConfirmButton: 'delete-confirm-button',

  // ---------- Update flow ----------
  /** A single channel card inside the Update tab (one per release channel). */
  updateChannelCard: (channel: string) => `update-channel-card-${channel}`,
  /** The "Update Now" / "Copy & Update" CTA inside a channel card. */
  updateActionButton: (actionId: string) => `update-action-${actionId}`,

  // ---------- Settings drawer / picker — pin-bottom MoreMenu ----------
  /** An action item inside the Settings drawer / picker's footer "More"
   *  menu. `actionId` matches the `ActionDef.id` shipped in the source's
   *  `pinBottom: true` section (e.g. `copy`, `delete`, `open-folder`),
   *  with the Launch→Restart swap surfacing as `restart` when the
   *  install is running. */
  pinBottomAction: (actionId: string) => `pin-bottom-action-${actionId}`,

  // ---------- Snapshots tab ----------
  /** A snapshot timeline row's expand toggle (header strip). `filename`
   *  is the snapshot's on-disk filename — stable across reloads. */
  snapshotRow: (filename: string) => `snapshot-row-${filename}`,
  /** The Restore CTA inside an expanded snapshot row's detail panel. */
  snapshotRowRestore: (filename: string) => `snapshot-row-restore-${filename}`,
  /** The Export CTA inside an expanded snapshot row's detail panel.
   *  Drives `window.api.exportSnapshot(installationId, filename)`. */
  snapshotRowExport: (filename: string) => `snapshot-row-export-${filename}`,
  /** The Snapshots tab toolbar's Import CTA. Drives the import preview
   *  → diff → confirm chain through `window.api.importSnapshots*`. */
  snapshotsImport: 'snapshots-import',
  /** The Snapshots tab toolbar's Export All CTA. Drives
   *  `window.api.exportAllSnapshots(installationId)`. */
  snapshotsExportAll: 'snapshots-export-all',
  /** The inline op-card that swaps into the dashed "Save New Snapshot"
   *  slot at the top of the rail while a snapshot-restore is in flight
   *  or in a terminal state (success/error). Single TID for the card
   *  itself; granular per-button TIDs follow. */
  snapshotsOpCard: 'snapshots-op-card',
  /** Cancel button on the in-flight op card. */
  snapshotsOpCardCancel: 'snapshots-op-card-cancel',
  /** Try-again button on the error op card. */
  snapshotsOpCardRetry: 'snapshots-op-card-retry',
  /** Dismiss button on the error op card. */
  snapshotsOpCardDismiss: 'snapshots-op-card-dismiss',

  // ---------- Progress takeover ----------
  /** The red error message block in the brand progress takeover. */
  progressErrorMessage: 'progress-error-message',
  /** The logs panel in the brand progress takeover. */
  progressLogs: 'progress-logs',
  /** The Reboot button in the brand progress takeover's error footer.
   *  Drives `handleReboot` (re-runs `op.apiCall` or falls back to a
   *  fresh `launch` action). */
  progressReboot: 'progress-reboot',
  /** The port-conflict banner in the brand progress takeover, rendered
   *  in place of the generic error banner when the failing op returned
   *  `result.portConflict`. */
  progressPortConflictBanner: 'progress-port-conflict-banner',
  /** The "Use port N instead" CTA in the port-conflict footer. Visible
   *  only when `portConflict.nextPort` is set. Drives `handleUseNextPort`
   *  which fires `runAction('launch', { portOverride: nextPort })`. */
  progressPortConflictUsePort: 'progress-port-conflict-use-port',
  /** The "Stop process and retry" CTA in the port-conflict footer.
   *  Visible only when `portConflict.isComfy` is true. Drives
   *  `handleKillProcess` (confirm → `killPortProcess` → re-run apiCall). */
  progressPortConflictKill: 'progress-port-conflict-kill',
} as const

export type TestIdKey = keyof typeof TID
