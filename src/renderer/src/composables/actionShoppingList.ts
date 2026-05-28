/**
 * Shopping-list chain steps shared by every `runAction` dispatcher
 * (`useComfyUISettings.runAction`, `DetailModal.runAction`, and any
 * future caller). Each helper:
 *   - reads `action.<chain>` and optionally drives a modal,
 *   - returns the new `ActionDef` (with merged `data` and any narrowed
 *     fields) when the chain step completed,
 *   - returns `null` when the user cancelled or the prerequisites
 *     failed (caller must short-circuit).
 *
 * The helpers DO NOT manage `wasRunning`, `requiresStoppedGuard`,
 * `showProgress` orchestration, telemetry, or post-result navigation —
 * those stay in the caller because they need install-store / progress-
 * store / emit access that varies per surface (panel vs. legacy modal).
 *
 * Extracting these eliminated ~270 lines of near-verbatim copy/paste
 * between `useComfyUISettings.runAction` and `DetailModal.runAction`
 * (audit annoying gap #4).
 */

import type { useModal } from './useModal'
import type { useDialogs } from './useDialogs'
import type { ActionDef, DiskSpaceInfo, FieldOption, Installation } from '../types/ipc'

type Modal = ReturnType<typeof useModal>
type Dialogs = ReturnType<typeof useDialogs>
/** Subset of `vue-i18n`'s `t` that the chain helpers need — keeping it
 *  loose-typed avoids pulling the full I18n type just to translate a
 *  handful of error / disk-space strings. */
type Translate = (key: string, payload?: Record<string, unknown>) => string

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** Drive `action.fieldSelects` — each step opens a `modal.select` whose
 *  options come from a main-side source (`getFieldOptions`). The user's
 *  pick feeds the next step AND lands on `action.data[fs.field]`. */
export async function runFieldSelectsChain(
  action: ActionDef,
  driver: Modal | Dialogs,
  t: Translate,
): Promise<ActionDef | null> {
  if (!action.fieldSelects) return action
  const showAlert = pickAlert(driver)
  const showPick = pickPicker(driver)
  let next = action
  const selections: Record<string, FieldOption> = {}
  for (const fs of action.fieldSelects) {
    let items: FieldOption[]
    try {
      items = await window.api.getFieldOptions(fs.sourceId, fs.fieldId, selections)
    } catch (err: unknown) {
      await showAlert({ title: next.label, message: (err as Error).message || String(err) })
      return null
    }
    if (!items || items.length === 0) {
      await showAlert({
        title: next.label,
        message: fs.emptyMessage || t('common.noItems'),
      })
      return null
    }
    const selectItems = items.map((item) => ({
      value: item.value,
      label: (item.recommended ? '★ ' : '') + item.label,
      description: item.description,
    }))
    const selected = await showPick({
      title: fs.title || next.label,
      message: fs.message || '',
      items: selectItems,
    })
    if (!selected) return null
    const selectedItem = items.find((i) => i.value === selected)
    if (selectedItem) selections[fs.fieldId] = selectedItem
    next = { ...next, data: { ...next.data, [fs.field]: selectedItem } }
  }
  return next
}

/** `useDialogs` exposes `actionSheet`; the legacy `useModal` exposes
 *  `select`. Both resolve to `string | null` for the picked value. The
 *  helpers below normalise around whichever driver the caller passed,
 *  so `useComfyUISettings` (BaseModal-shell dialogs) and `DetailModal`
 *  (legacy modal host) can share the chain code unchanged. */
function isDialogs(driver: Modal | Dialogs): driver is Dialogs {
  return typeof (driver as Dialogs).actionSheet === 'function'
}
function pickAlert(driver: Modal | Dialogs) {
  return (opts: { title: string; message: string }): Promise<unknown> => driver.alert(opts)
}
function pickPicker(driver: Modal | Dialogs) {
  return (opts: { title: string; message: string; items: { value: string; label: string; description?: string }[] }): Promise<string | null> =>
    isDialogs(driver) ? driver.actionSheet(opts) : driver.select(opts)
}
function pickPrompt(driver: Modal | Dialogs) {
  return (opts: Parameters<Modal['prompt']>[0]): Promise<string | null> => driver.prompt(opts)
}

/** Drive `action.select` — a single named-source pick (currently only
 *  `'installations'` is wired; expandable later). Lands the selected id
 *  on `action.data[action.select.field]`. */
export async function runSelectChain(
  action: ActionDef,
  ownerInstallationId: string,
  driver: Modal | Dialogs,
  t: Translate,
): Promise<ActionDef | null> {
  if (!action.select) return action
  const showAlert = pickAlert(driver)
  const showPick = pickPicker(driver)
  let items: { value: string; label: string; description?: string }[] | undefined
  if (action.select.source === 'installations') {
    let all = await window.api.getInstallations()
    if (action.select.excludeSelf) {
      all = all.filter((i) => i.id !== ownerInstallationId)
    }
    if (action.select.filters) {
      for (const [key, value] of Object.entries(action.select.filters)) {
        all = all.filter((i) => (i as Record<string, unknown>)[key] === value)
      }
    }
    items = all.map((i) => ({ value: i.id, label: i.name, description: i.sourceLabel }))
  }
  if (!items || items.length === 0) {
    await showAlert({
      title: action.label,
      message: action.select.emptyMessage || t('common.noItems'),
    })
    return null
  }
  const selected = await showPick({
    title: action.select.title || action.label,
    message: action.select.message || '',
    items,
  })
  if (!selected) return null
  return { ...action, data: { ...action.data, [action.select.field]: selected } }
}

/** Drive `action.prompt` — free-form text input (e.g. "Copy to new
 *  install name"). Lands the value on `action.data[action.prompt.field]`. */
export async function runPromptChain(
  action: ActionDef,
  driver: Modal | Dialogs,
): Promise<ActionDef | null> {
  if (!action.prompt) return action
  const showPrompt = pickPrompt(driver)
  const value = await showPrompt({
    title: action.prompt.title || action.label,
    message: action.prompt.message || '',
    placeholder: action.prompt.placeholder,
    defaultValue: action.prompt.defaultValue,
    confirmLabel: action.prompt.confirmLabel || action.label,
    required: action.prompt.required,
    messageDetails: action.prompt.messageDetails,
  })
  if (!value) return null
  return { ...action, data: { ...action.data, [action.prompt.field]: value } }
}

/** Drive `action.confirm`. Routes the plain-confirm path through
 *  `dialogs.confirm` (BaseModal-shell) when a dialogs driver is
 *  supplied; falls back to `modal.confirm` otherwise. The
 *  checkbox-confirm path (`confirm.options`) always uses
 *  `modal.confirmWithOptions` — `useDialogs` has no equivalent yet.
 *  The caller is responsible for skipping migrate-to-standalone. */
export async function runConfirmChain(
  action: ActionDef,
  modal: Modal,
  dialogs?: Dialogs,
): Promise<ActionDef | null> {
  if (!action.confirm) return action
  if (action.confirm.options) {
    const result = await modal.confirmWithOptions({
      title: action.confirm.title || 'Confirm',
      message: action.confirm.message || 'Are you sure?',
      options: action.confirm.options,
      confirmLabel: action.confirm.confirmLabel || action.label,
      confirmStyle: action.style || 'danger',
    })
    if (!result) return null
    return { ...action, data: { ...action.data, ...result } }
  }
  if (dialogs) {
    const result = await dialogs.confirm({
      title: action.confirm.title || 'Confirm',
      message: action.confirm.message || 'Are you sure?',
      messageDetails: action.confirm.messageDetails,
      restoreDiff: action.confirm.restoreDiff,
      confirmLabel: action.confirm.confirmLabel || action.label,
      tone: action.style === 'primary' || action.style === 'accent' ? 'primary' : 'danger',
    })
    return result === 'primary' ? action : null
  }
  const confirmed = await modal.confirm({
    title: action.confirm.title || 'Confirm',
    message: action.confirm.message || 'Are you sure?',
    messageDetails: action.confirm.messageDetails,
    confirmLabel: action.label,
    confirmStyle: action.style || 'danger',
  })
  return confirmed ? action : null
}

/** Disk-space sanity check for the `copy` / `copy-update` /
 *  `release-update` write-heavy actions. Pre-fetched
 *  `installationSizeBytes` (when present) skips the IPC round-trip
 *  needed by the on-the-fly fallback. Returns `false` when the user
 *  declined the over-quota prompt. */
export async function runDiskSpaceCheck(
  action: ActionDef,
  installation: Installation,
  modal: Modal,
  t: Translate,
  installationSizeBytes?: number | null,
  dialogs?: Dialogs,
): Promise<boolean> {
  const diskCheckActions = new Set(['copy', 'copy-update', 'release-update'])
  if (!diskCheckActions.has(action.id) || !installation.installPath) return true
  try {
    const space: DiskSpaceInfo = await window.api.getDiskSpace(installation.installPath)
    let estimatedRequired = 0
    if (action.id === 'copy' || action.id === 'copy-update') {
      if (installationSizeBytes != null) {
        estimatedRequired = installationSizeBytes
      } else {
        try {
          const r = await window.api.getInstallationSize(installation.id)
          estimatedRequired = r.sizeBytes
        } catch {
          // fall through to generic threshold
        }
      }
    }
    const threshold = estimatedRequired > 0 ? Math.ceil(estimatedRequired * 1.1) : 1073741824
    if (space.free < threshold) {
      const freeStr = formatBytes(space.free)
      const message = estimatedRequired > 0
        ? t('diskSpace.warningMessage', { free: freeStr, required: formatBytes(estimatedRequired) })
        : t('diskSpace.warningMessageGeneric', { free: freeStr })
      if (dialogs) {
        const result = await dialogs.confirm({
          title: t('diskSpace.warningTitle'),
          message,
          confirmLabel: t('diskSpace.continueAnyway'),
          tone: 'primary',
        })
        if (result !== 'primary') return false
      } else {
        const ok = await modal.confirm({
          title: t('diskSpace.warningTitle'),
          message,
          confirmLabel: t('diskSpace.continueAnyway'),
          confirmStyle: 'primary',
        })
        if (!ok) return false
      }
    }
  } catch {
    // If the disk check itself fails, proceed.
  }
  return true
}
