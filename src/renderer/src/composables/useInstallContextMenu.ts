import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import type { ContextMenuItem } from '../types/context-menu'
import type { Installation } from '../types/ipc'

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
   *  funnels Update / Migrate / Restore Snapshot / Delete through this
   *  callback with the appropriate `initialTab` / `autoAction` so the
   *  source-side action machinery (confirms, prompts, showProgress) is
   *  reused. The bare Manage… item passes no options. */
  onManage?: (inst: Installation, options?: ManageOpenOptions) => void
} = {}) {
  const { t } = useI18n()
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
        label: t('chooser.menuRevealInFolder'),
        separator: items.length > 0,
      })
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

    // Untrack Installation — drops the install from the app's registry
    // without touching disk. Available for any local-like installed
    // install (matches the existing `untrackAction()` source-side gating).
    if (isInstalled(inst) && isLocalLikeInstall(inst)) {
      items.push({
        id: 'untrack',
        label: t('actions.untrack'),
      })
    }

    if (isInstalled(inst) && isLocalLikeInstall(inst)) {
      items.push({
        id: 'delete',
        label: t('chooser.menuDelete'),
        separator: items.length > 0,
        disabled: stoppedActionGated,
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
      try {
        await window.api.runAction(inst.id, 'open-folder')
      } catch {
        // The action surfaces its own error to the user via main; nothing to do here.
      }
    } else if (id === 'copy-install') {
      // Standalone-only. Source-side `'copy'` action def owns its
      // native confirm dialog + showProgress chain, so the panel still
      // sees a progress overlay when this fires.
      try {
        await window.api.runAction(inst.id, 'copy')
      } catch {
        // Source action surfaces its own error path.
      }
    } else if (id === 'untrack') {
      // Source-side `'remove'` action def owns its native confirm.
      try {
        await window.api.runAction(inst.id, 'remove')
      } catch {
        // Source action surfaces its own error path.
      }
    } else if (id === 'delete') {
      // When `onManage` is wired (chooser / dashboard kebab) we route
      // through DetailModal so the source's auto-action chain runs in
      // the modal context. When it isn't (e.g. picker forwarded path),
      // fire the source-side `'delete'` action directly — the action
      // def owns its own native confirm + showProgress wiring, so the
      // panel's progress overlay still fires through the standard
      // `show-progress` → ProgressModal path.
      if (opts.onManage) {
        opts.onManage(inst, { autoAction: 'delete' })
      } else {
        try {
          await window.api.runAction(inst.id, 'delete')
        } catch {
          // Source action surfaces its own error path.
        }
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
