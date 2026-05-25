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
  /** Generic confirm modal confirm button. */
  modalConfirm: 'modal-confirm-button',
  /** Generic confirm modal cancel button. */
  modalCancel: 'modal-cancel-button',
  /** The primary action button of a `BaseAlert` (alert OK / simple
   *  confirm primary). Hard-coded in `BaseAlert.vue` — kept here so
   *  tests reference a single source of truth. */
  baseAlertAction: 'base-alert-action',
  /** The cancel button of a simple-confirm `BaseAlert`. */
  baseAlertCancel: 'base-alert-cancel',
  /** Delete-install confirmation modal (the whole modal, for visibility waits). */
  deleteConfirmModal: 'delete-confirm-modal',
  /** Delete-install confirmation confirm button. */
  deleteConfirmButton: 'delete-confirm-button',

  // ---------- Update flow ----------
  /** A single channel card inside the Update tab (one per release channel). */
  updateChannelCard: (channel: string) => `update-channel-card-${channel}`,
  /** The "Update Now" / "Copy & Update" CTA inside a channel card. */
  updateActionButton: (actionId: string) => `update-action-${actionId}`,

  // ---------- Progress takeover ----------
  /** The red error message block in the brand progress takeover. */
  progressErrorMessage: 'progress-error-message',
  /** The logs panel in the brand progress takeover. */
  progressLogs: 'progress-logs',
} as const

export type TestIdKey = keyof typeof TID
