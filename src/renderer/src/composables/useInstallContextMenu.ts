import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useModal } from './useModal'
import { revealInFolderLabel } from './usePlatform'
import { progressOpKindForActionId, destroysInstanceForActionId } from '../lib/progressOpKind'
import { shareLatestSnapshot } from '../lib/snapshots'
import type { ContextMenuItem } from '../types/context-menu'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Action / context menu for chooser tiles. Powers two surfaces:
 *
 *   - **Right-click context menu** (`openCardMenu`) — anchored at the
 *     click coordinates.
 *   - **Kebab (top-right ⋮ icon) action menu** (`openKebabMenu`) —
 *     anchored at the kebab button's bottom-right so the menu drops
 *     down beneath the icon. Same items either way.
 *
 * Items:
 *
 *   - **Manage…** — opens the install's `DetailModal` overlay so the
 *     user can edit settings, run actions, etc.
 *   - **Update…** (`status === 'installed'` && `statusTag.style ===
 *     'update'`) — opens Manage on the Update tab.
 *   - **Migrate to Standalone…** (`sourceCategory === 'desktop'` &&
 *     installed) — opens Manage with the migrate-to-standalone
 *     auto-action.
 *   - **Restore Snapshot…** (`status === 'installed'` && `installPath`
 *     && non-cloud) — opens Manage on the Snapshots tab.
 *   - **Open Folder** (installPath && non-cloud) — instant action via
 *     the `open-folder` source-action; no overlay.
 *   - **Delete…** (`status === 'installed'` && non-cloud) — opens
 *     Manage with the delete auto-action so the source-side action
 *     def's confirm + showProgress flow runs (Tier 2 progress for
 *     stopped installs — Delete requires stopped).
 *   - **Dismiss error** (when the install has a stored error).
 *
 * Items whose underlying action is REQUIRES_STOPPED — Update,
 * Migrate, Restore Snapshot, Delete — render as `disabled` whenever
 * the install is currently running, mid-shutdown, or has a long-
 * running op in flight. This mirrors the gating main applies via the
 * REQUIRES_STOPPED guard in `registerSessionHandlers`, so users see
 * which controls are locked rather than clicking and hitting a no-op
 * / "operation in progress" error.
 *
 * The same items power the chooser tile's update/migrate visual
 * pills via `triggerAction(id, inst)` — pill click and kebab item
 * click route through one dispatch path so the two surfaces cannot
 * diverge.
 *
 * Card click — single click on the tile body — opens the install
 * directly (`@click="pickInstall"` in ChooserView). The kebab button
 * stops propagation so clicking the icon doesn't also fire the
 * card-level open.
 */
export type InstallMenuActionId =
  | 'manage'
  | 'update'
  | 'migrate'
  | 'restore-snapshot'
  | 'reveal-in-folder'
  | 'share'
  | 'copy-install'
  | 'untrack'
  | 'delete'
  | 'dismiss-error'

export interface ManageOpenOptions {
  initialTab?: string
  autoAction?: string | null
}

export function useInstallContextMenu(opts: {
  /** Open the per-install Manage… DetailModal overlay. The composable
   *  funnels Update / Migrate / Restore Snapshot / Copy Installation /
   *  Untrack through this callback with the appropriate `initialTab` /
   *  `autoAction` so the source-side action machinery (confirms,
   *  prompts, disk-check, showProgress) is reused. The bare Manage…
   *  item passes no options. */
  onManage?: (inst: Installation, options?: ManageOpenOptions) => void
  /** Optional fast-path for actions that own their own confirm +
   *  showProgress pair (today: Delete). When provided, the composable
   *  fetches the action def from main, runs the confirm directly via
   *  the global ModalDialog, and emits `show-progress` for ProgressModal
   *  — skipping the ManageInstallModal flash that briefly painted the
   *  drawer's loading spinner between mount and confirm. Falls back to
   *  `onManage(inst, { autoAction })` when omitted, preserving the
   *  legacy path for surfaces that don't host ProgressModal directly. */
  onShowProgress?: (showOpts: ShowProgressOpts) => void
} = {}) {
  const { t } = useI18n()
  const modal = useModal()
  const sessionStore = useSessionStore()
  const progressStore = useProgressStore()

  const ctxMenu = ref({
    open: false,
    x: 0,
    y: 0,
    inst: null as Installation | null,
  })

  function isLocalLikeInstall(inst: Installation): boolean {
    return inst.sourceCategory !== 'cloud'
  }

  function isInstalled(inst: Installation): boolean {
    return inst.status === 'installed'
  }

  function hasUpdateTag(inst: Installation): boolean {
    return inst.statusTag?.style === 'update'
  }

  function hasMigratePrompt(inst: Installation): boolean {
    return inst.sourceCategory === 'desktop' && isInstalled(inst)
  }

  function hasInstallPath(inst: Installation): boolean {
    return !!inst.installPath
  }

  /** True when REQUIRES_STOPPED actions (update / migrate / restore /
   *  delete) would no-op for this install: the install is currently
   *  running, mid-shutdown, or has a long-running op in flight.
   *  Drives the `disabled` flag on the menu items that wrap those
   *  actions so the user can see which controls are gated. The
   *  predicate matches the renderer-observable signals that
   *  `registerSessionHandlers` checks via `_runningSessions` and
   *  `_operationAborts` in main. */
  function isStoppedActionGated(inst: Installation): boolean {
    return sessionStore.isRunning(inst.id)
      || sessionStore.isStopping(inst.id)
      || progressStore.getProgressInfo(inst.id) !== null
  }

  function getMenuItems(inst: Installation): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    const stoppedActionGated = isStoppedActionGated(inst)

    if (opts.onManage) {
      items.push({
        id: 'manage',
        label: t('chooser.manageInstall'),
      })

      if (isInstalled(inst) && hasUpdateTag(inst)) {
        items.push({ id: 'update', label: t('chooser.menuUpdate'), disabled: stoppedActionGated })
      }
      if (hasMigratePrompt(inst)) {
        items.push({ id: 'migrate', label: t('chooser.menuMigrate'), disabled: stoppedActionGated })
      }
      if (isInstalled(inst) && hasInstallPath(inst) && isLocalLikeInstall(inst)) {
        items.push({ id: 'restore-snapshot', label: t('chooser.menuRestoreSnapshot'), disabled: stoppedActionGated })
      }
    }

    if (hasInstallPath(inst) && isLocalLikeInstall(inst)) {
      items.push({
        id: 'reveal-in-folder',
        label: revealInFolderLabel(window.api?.platform),
        separator: items.length > 0,
      })
    }

    // Share — export the latest snapshot via the OS save dialog. Snapshots
    // are local-only and captured once the install has booted, so gate on
    // installed + local. Promotes the per-row Snapshots-tab export to a
    // top-level action.
    if (isInstalled(inst) && hasInstallPath(inst) && isLocalLikeInstall(inst)) {
      items.push({ id: 'share', label: t('actions.share', 'Share') })
    }

    // Copy Installation — standalone source only (the `'copy'` action
    // def lives in standalone/updateSections.ts). REQUIRES_STOPPED.
    if (isInstalled(inst) && inst.sourceCategory === 'local') {
      items.push({
        id: 'copy-install',
        label: t('actions.copyInstallation'),
        disabled: stoppedActionGated,
      })
    }

    // Destructive bucket — Untrack + Delete share one separator group
    // because both remove the install from the picker. Untrack drops
    // the registry entry only; Delete also wipes disk. Keeping them
    // adjacent under a single divider scans as "remove this install,
    // pick how" instead of two unrelated leaf items.
    if (isInstalled(inst) && isLocalLikeInstall(inst)) {
      items.push({
        id: 'untrack',
        label: t('actions.untrack'),
        separator: items.length > 0,
        style: 'danger',
      })
      items.push({
        id: 'delete',
        label: t('chooser.menuDelete'),
        disabled: stoppedActionGated,
        style: 'danger',
      })
    }

    if (sessionStore.errorInstances.has(inst.id)) {
      items.push({
        id: 'dismiss-error',
        label: t('running.dismiss'),
        separator: items.length > 0,
      })
    }

    return items
  }

  /** Right-click on a card — anchor at click coords. */
  function openCardMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst)
    if (items.length === 0) return
    event.preventDefault()
    ctxMenu.value = { open: true, x: event.clientX, y: event.clientY, inst }
  }

  /** Click on the kebab (⋮) button — anchor at the button's bottom-
   *  right so the menu drops beneath the icon. The caller passes the
   *  click event so we can resolve the button's bounding rect. */
  function openKebabMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst)
    if (items.length === 0) return
    event.stopPropagation()
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.()
    // Right-aligned drop: the menu's left edge sits at the kebab's
    // right edge minus a guess of the menu width, so the menu visually
    // hangs from the icon. ContextMenu clamps to viewport, so going
    // negative on x is safe — it'll get pushed back into bounds.
    const x = rect ? rect.right - 180 : event.clientX
    const y = (rect?.bottom ?? event.clientY) + 4
    ctxMenu.value = { open: true, x, y, inst }
  }

  const ctxMenuItems = computed<ContextMenuItem[]>(() => {
    const inst = ctxMenu.value.inst
    if (!inst) return []
    return getMenuItems(inst)
  })

  /** Run a fire-and-forget action (no overlay / prompt) and surface a
   *  failure via `modal.alert` instead of swallowing it. Main returns
   *  `{ ok: false, message }` on action-level failures (e.g. open-folder
   *  against a missing path); the bare `try { ... } catch {}` pattern
   *  it replaces only caught true rejections, leaving the user staring
   *  at a no-op kebab item with no feedback. */
  async function runInstantActionWithAlert(inst: Installation, actionId: string, actionLabel: string): Promise<void> {
    try {
      const result = await window.api.runAction(inst.id, actionId)
      if (result.ok === false && result.message) {
        await modal.alert({ title: actionLabel, message: result.message })
      }
    } catch (err) {
      const message = (err as Error)?.message || String(err)
      await modal.alert({ title: actionLabel, message })
    }
  }

  /** Single dispatch path for both the kebab/right-click menu and the
   *  chooser tile's visual pills. Pill clicks (`triggerAction('update',
   *  inst)` / `triggerAction('migrate', inst)`) and menu selections
   *  funnel through here so the two surfaces cannot diverge. */
  async function triggerAction(id: string, inst: Installation): Promise<void> {
    if (id === 'manage') {
      opts.onManage?.(inst)
    } else if (id === 'update') {
      opts.onManage?.(inst, { initialTab: 'update' })
    } else if (id === 'migrate') {
      opts.onManage?.(inst, { autoAction: 'migrate-to-standalone' })
    } else if (id === 'restore-snapshot') {
      opts.onManage?.(inst, { initialTab: 'snapshots' })
    } else if (id === 'reveal-in-folder') {
      await runInstantActionWithAlert(inst, 'open-folder', revealInFolderLabel(window.api?.platform))
    } else if (id === 'share') {
      // Share = export the latest snapshot. The export IPC owns its own OS
      // save dialog; a cancel is a silent no-op. Only surface the genuine
      // failure cases (no snapshots yet, or a write error).
      const label = t('actions.share', 'Share')
      try {
        const result = await shareLatestSnapshot(inst.id)
        if (!result.ok) {
          await modal.alert({
            title: label,
            message:
              result.reason === 'none'
                ? t('snapshots.noSnapshotsToShare', 'There are no snapshots to share yet.')
                : result.message ?? t('snapshots.shareFailed', 'Could not share the snapshot.'),
          })
        }
      } catch (err) {
        await modal.alert({ title: label, message: (err as Error)?.message || String(err) })
      }
    } else if (id === 'copy-install') {
      // Route through the source-action def by handing the autoAction
      // off to `onManage`. Calling `window.api.runAction(id, 'copy')`
      // directly bypassed the renderer-side prompt / disk-check /
      // showProgress chain — main saw `actionData = undefined` and
      // bailed with `{ ok: false, message: 'No name provided.' }`,
      // which the caller's `try/catch` then silently swallowed.
      opts.onManage?.(inst, { autoAction: 'copy' })
    } else if (id === 'untrack') {
      /** Confirm + instant `remove` IPC. No picker, no progress bar —
       *  untrack is a registry-only op. */
      const untrackLabel = t('actions.untrack', 'Forget')
      const confirmed = await modal.confirm({
        title: t('actions.untrackConfirmTitle', 'Forget Install'),
        message: t(
          'actions.untrackConfirmMessage',
          'This will remove the install from the app. The files will not be deleted.',
        ),
        confirmLabel: untrackLabel,
        confirmStyle: 'danger',
      })
      if (!confirmed) return
      await runInstantActionWithAlert(inst, 'remove', untrackLabel)
    } else if (id === 'delete') {
      // Build the confirm + showProgress payload renderer-side instead
      // of round-tripping through `getDetailSections` to look up the
      // source-side `deleteAction()` shape — the full payload rebuild
      // was the ~2s confirm-modal stall on Windows. Cloud installs are
      // already filtered out of the menu via `isLocalLikeInstall` +
      // `isInstalled` gates in `ctxMenuItems`, so this path only sees
      // local installs whose delete behaviour matches `actions.ts`.
      if (opts.onShowProgress) {
        // English fallbacks: PanelApp merges `locales/en.json`
        // asynchronously after mount, so a very fast first click could
        // otherwise render raw dotted keys.
        const deleteLabel = t('actions.delete', 'Delete')
        const confirmed = await modal.confirm({
          title: t('actions.deleteConfirmTitle', 'Delete Install'),
          message: `${t(
            'actions.deleteConfirmMessage',
            'This will permanently delete the install and all its files. This cannot be undone.',
          )}\n${inst.installPath ?? ''}`,
          confirmLabel: deleteLabel,
          confirmStyle: 'danger',
        })
        if (!confirmed) return
        opts.onShowProgress({
          installationId: inst.id,
          title: `${deleteLabel} — ${inst.name}`,
          apiCall: () => window.api.runAction(inst.id, 'delete'),
          cancellable: true,
          returnTo: 'list',
          opKind: progressOpKindForActionId('delete'),
          destroysInstance: destroysInstanceForActionId('delete'),
        })
        return
      }
      if (opts.onManage) {
        // Legacy path — DetailModal autoAction chain. Used when the
        // host doesn't expose `onShowProgress` (rare; picker forwards
        // strings to the panel router which has both callbacks).
        opts.onManage(inst, { autoAction: 'delete' })
      } else {
        await runInstantActionWithAlert(inst, 'delete', t('chooser.menuDelete'))
      }
    } else if (id === 'dismiss-error') {
      sessionStore.clearErrorInstance(inst.id)
    }
  }

  async function handleCtxMenuSelect(id: string): Promise<void> {
    const inst = ctxMenu.value.inst
    if (!inst) return
    await triggerAction(id, inst)
  }

  function closeMenu(): void {
    ctxMenu.value.open = false
  }

  return {
    ctxMenu,
    ctxMenuItems,
    openCardMenu,
    openKebabMenu,
    handleCtxMenuSelect,
    closeMenu,
    triggerAction,
    isStoppedActionGated,
  }
}
