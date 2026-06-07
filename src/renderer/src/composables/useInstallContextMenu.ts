import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useModal } from './useModal'
import { useStopAction } from './useStopAction'
import { revealInFolderLabel } from './usePlatform'
import { progressOpKindForActionId, destroysInstanceForActionId } from '../lib/progressOpKind'
import { shareLatestSnapshot } from '../lib/snapshots'
import type { ContextMenuItem } from '../types/context-menu'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/** Action / context menu for chooser tiles, powering both the right-click
 *  context menu and the kebab (⋮) action menu with the same items. The
 *  same items also drive the tile's update/migrate pills via
 *  `triggerAction`, so the surfaces cannot diverge.
 *
 *  REQUIRES_STOPPED items (Update, Migrate, Restore, Delete) render
 *  `disabled` while the install is running, stopping, or has an op in
 *  flight, mirroring main's REQUIRES_STOPPED guard. */
export type InstallMenuActionId =
  | 'manage'
  | 'update'
  | 'migrate'
  | 'restore-snapshot'
  | 'stop'
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
  /** Open the per-install Manage… overlay. Items funnel through this with
   *  the right `initialTab` / `autoAction` so the source-side action
   *  machinery is reused. */
  onManage?: (inst: Installation, options?: ManageOpenOptions) => void
  /** Fast-path for actions that own their own confirm + showProgress
   *  (Delete). Avoids the ManageInstallModal spinner flash. Falls back
   *  to `onManage(inst, { autoAction })` when omitted. */
  onShowProgress?: (showOpts: ShowProgressOpts) => void
} = {}) {
  const { t } = useI18n()
  const modal = useModal()
  const { confirmAndStop } = useStopAction({
    confirm: (o) => modal.confirm({ ...o, confirmStyle: 'danger' }),
    alert: (o) => modal.alert(o),
  })
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
    // The backend tags every migratable install (Legacy Desktop, portable,
    // git) with a `migrate` status tag — mirror the `hasUpdateTag` pattern
    // rather than special-casing a single source.
    return inst.statusTag?.style === 'migrate'
  }

  function hasInstallPath(inst: Installation): boolean {
    return !!inst.installPath
  }

  /** True when REQUIRES_STOPPED actions would no-op: install is running,
   *  stopping, or has an op in flight. Drives the `disabled` flag. */
  function isStoppedActionGated(inst: Installation): boolean {
    return sessionStore.isRunning(inst.id)
      || sessionStore.isStopping(inst.id)
      || progressStore.getProgressInfo(inst.id) !== null
  }

  function getMenuItems(inst: Installation): ContextMenuItem[] {
    const items: ContextMenuItem[] = []
    const stoppedActionGated = isStoppedActionGated(inst)
    // Tooltip explaining why the gated items are greyed out.
    const gatedTitle = stoppedActionGated ? t('chooser.stoppedActionGatedReason') : undefined

    if (opts.onManage) {
      items.push({
        id: 'manage',
        label: t('chooser.manageInstall'),
      })

      if (isInstalled(inst) && hasUpdateTag(inst)) {
        items.push({ id: 'update', label: t('chooser.menuUpdate'), disabled: stoppedActionGated, title: gatedTitle })
      }
      if (hasMigratePrompt(inst)) {
        items.push({ id: 'migrate', label: t('chooser.menuMigrate'), disabled: stoppedActionGated, title: gatedTitle })
      }
      if (isInstalled(inst) && hasInstallPath(inst) && isLocalLikeInstall(inst)) {
        items.push({ id: 'restore-snapshot', label: t('chooser.menuRestoreSnapshot'), disabled: stoppedActionGated, title: gatedTitle })
      }
    }

    if (hasInstallPath(inst) && isLocalLikeInstall(inst)) {
      items.push({
        id: 'reveal-in-folder',
        label: revealInFolderLabel(window.api?.platform),
        separator: items.length > 0,
      })
    }

    // Share — export the latest snapshot. Local-only and post-boot, so
    // gate on installed + local.
    if (isInstalled(inst) && hasInstallPath(inst) && isLocalLikeInstall(inst)) {
      items.push({ id: 'share', label: t('actions.share', 'Share') })
    }

    // Copy Installation — standalone source only. REQUIRES_STOPPED.
    if (isInstalled(inst) && inst.sourceCategory === 'local') {
      items.push({
        id: 'copy-install',
        label: t('actions.copyInstallation'),
        disabled: stoppedActionGated,
        title: gatedTitle,
      })
    }

    // Bottom cluster — Stop (running only) + Untrack (registry only, hidden for
    // adopted installs whose legacy marker would re-track them) + Delete (wipes
    // disk). Built as one group so only its first item draws the divider.
    const cluster: ContextMenuItem[] = []
    if (isLocalLikeInstall(inst) && sessionStore.isRunning(inst.id)) {
      cluster.push({ id: 'stop', label: t('actions.stop', 'Stop'), style: 'danger' })
    }
    if (isInstalled(inst) && isLocalLikeInstall(inst)) {
      if (!inst.adopted) {
        cluster.push({ id: 'untrack', label: t('actions.untrack'), style: 'danger' })
      }
      cluster.push({
        id: 'delete',
        label: t('chooser.menuDelete'),
        disabled: stoppedActionGated,
        title: gatedTitle,
        style: 'danger',
      })
    }
    const [clusterHead] = cluster
    if (clusterHead) {
      clusterHead.separator = items.length > 0
      items.push(...cluster)
    }

    if (sessionStore.errorInstances.has(inst.id)) {
      items.push({
        id: 'dismiss-error',
        label: t('chooser.menuDismissError'),
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

  /** Click on the kebab (⋮) button — anchor the menu beneath the icon. */
  function openKebabMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst)
    if (items.length === 0) return
    event.stopPropagation()
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.()
    // Right-aligned drop. ContextMenu clamps to viewport, so a negative x
    // is safe.
    const x = rect ? rect.right - 180 : event.clientX
    const y = (rect?.bottom ?? event.clientY) + 4
    ctxMenu.value = { open: true, x, y, inst }
  }

  const ctxMenuItems = computed<ContextMenuItem[]>(() => {
    const inst = ctxMenu.value.inst
    if (!inst) return []
    return getMenuItems(inst)
  })

  /** Run a fire-and-forget action and surface a failure via `modal.alert`.
   *  Main returns `{ ok: false, message }` on action-level failures, not
   *  just rejections. */
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

  /** Single dispatch path for both menus and the tile's visual pills, so
   *  the surfaces cannot diverge. */
  async function triggerAction(id: string, inst: Installation): Promise<void> {
    if (id === 'manage') {
      opts.onManage?.(inst)
    } else if (id === 'update') {
      // Open the Update tab AND auto-fire the update so the modal runs.
      opts.onManage?.(inst, { initialTab: 'update', autoAction: 'update-comfyui' })
    } else if (id === 'migrate') {
      opts.onManage?.(inst, { autoAction: 'migrate-to-standalone' })
    } else if (id === 'restore-snapshot') {
      opts.onManage?.(inst, { initialTab: 'snapshots' })
    } else if (id === 'stop') {
      // Stop the Python backend but leave the window/frontend alive (main's
      // onComfyExited swaps the body to the lifecycle card). Shared confirm +
      // stop logic lives in useStopAction.
      await confirmAndStop(inst.id)
    } else if (id === 'reveal-in-folder') {
      await runInstantActionWithAlert(inst, 'open-folder', revealInFolderLabel(window.api?.platform))
    } else if (id === 'share') {
      // Export the latest snapshot. The IPC owns its own save dialog; a
      // cancel is a silent no-op. Only surface genuine failures.
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
      // Route through `onManage` so the prompt / disk-check / showProgress
      // chain runs; calling `runAction('copy')` directly bails on a
      // missing name.
      opts.onManage?.(inst, { autoAction: 'copy' })
    } else if (id === 'untrack') {
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
      // Build the confirm + showProgress payload renderer-side instead of
      // round-tripping through `getDetailSections` (the ~2s Windows stall).
      if (opts.onShowProgress) {
        // English fallbacks: locales merge in after mount, so a fast first
        // click could otherwise render raw dotted keys.
        const deleteLabel = t('actions.delete', 'Delete')
        const confirmed = await modal.confirm({
          title: t('actions.deleteConfirmTitle', 'Delete Install'),
          message: `${inst.installPath ? inst.installPath + '\n\n' : ''}${t(
            'actions.deleteConfirmMessage',
            'This permanently removes this ComfyUI installation and all its files. This cannot be undone.',
          )}\n\n${t(
            'actions.deleteConfirmDetail',
            'Other installs are not affected.',
          )}`,
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
        // Fallback when the host doesn't expose `onShowProgress`.
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
