import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLauncherPrefs } from './useLauncherPrefs'
import { useSessionStore } from '../stores/sessionStore'
import type { ContextMenuItem } from '../types/context-menu'
import type { Installation } from '../types/ipc'

/**
 * Action / context menu for chooser tiles. The same composable powers
 * two surfaces:
 *
 *   - **Right-click context menu** (mode `'context'`) — accessory
 *     actions only: Pin / Unpin (non-cloud), Dismiss error (when the
 *     install has a stored error).
 *   - **Primary-click action popover** (mode `'action'`) — adds an
 *     **Open** entry at the top so the popover doubles as the entry-
 *     point for opening the install. Double-click on the card still
 *     bypasses the popover and opens directly (the fast-path); the
 *     popover is for the discoverable "click → see what I can do"
 *     gesture.
 *
 * The two modes share a single ContextMenu instance and a single
 * `ctxMenu` state — they're mutually exclusive (a click on a tile
 * dismisses any open right-click menu and vice versa).
 *
 * Action coverage in the popover is currently the minimum that works
 * without an install-backed host window: Open, Pin/Unpin, Dismiss
 * error. Update / Migrate / Install Settings / Reveal in Folder /
 * Restore Snapshot / Delete depend on the
 * `open-install-host-window-on-panel(installationId, panel)` IPC
 * tracked in Issue #470 — once that lands, those items move into this
 * popover so the chooser becomes the single launching surface for any
 * install action.
 */
export function useInstallContextMenu(opts: {
  /** Called when the user picks "Open" from the action popover. The
   *  caller decides whether to swap-in-place, open a fresh window, or
   *  hand off to a launch flow — this composable just routes the
   *  selection. Required for `openActionMenu`; ignored for
   *  `openContextMenu`. */
  onOpen?: (inst: Installation) => void
} = {}) {
  const { t } = useI18n()
  const prefs = useLauncherPrefs()
  const sessionStore = useSessionStore()

  type MenuMode = 'context' | 'action'
  const ctxMenu = ref({
    open: false,
    x: 0,
    y: 0,
    inst: null as Installation | null,
    mode: 'context' as MenuMode,
  })

  function getMenuItems(inst: Installation, mode: MenuMode): ContextMenuItem[] {
    const items: ContextMenuItem[] = []

    if (mode === 'action') {
      items.push({
        id: 'open',
        label: t('chooser.openInstall'),
      })
    }

    if (inst.sourceCategory !== 'cloud') {
      items.push({
        id: prefs.isPinned(inst.id) ? 'unpin' : 'pin',
        label: prefs.isPinned(inst.id) ? t('dashboard.unpinFromDashboard') : t('dashboard.pinToDashboard'),
        separator: mode === 'action',
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

  /** Right-click — open the accessory context menu. No Open entry. */
  function openCardMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst, 'context')
    if (items.length === 0) return
    event.preventDefault()
    ctxMenu.value = { open: true, x: event.clientX, y: event.clientY, inst, mode: 'context' }
  }

  /** Primary-click — open the action popover anchored to the tile. The
   *  popover is positioned at the bottom-left of the tile rect rather
   *  than the click coordinates so the menu always opens in a
   *  predictable location regardless of where on the card the user
   *  clicked. Falls back to click coords if the rect lookup fails. */
  function openActionMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst, 'action')
    if (items.length === 0) return
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect?.()
    const x = rect?.left ?? event.clientX
    const y = (rect?.bottom ?? event.clientY) + 4
    ctxMenu.value = { open: true, x, y, inst, mode: 'action' }
  }

  const ctxMenuItems = computed<ContextMenuItem[]>(() => {
    const inst = ctxMenu.value.inst
    if (!inst) return []
    return getMenuItems(inst, ctxMenu.value.mode)
  })

  async function handleCtxMenuSelect(id: string): Promise<void> {
    const inst = ctxMenu.value.inst
    if (!inst) return
    if (id === 'open') {
      opts.onOpen?.(inst)
    } else if (id === 'pin') {
      await prefs.pinInstall(inst.id)
    } else if (id === 'unpin') {
      await prefs.unpinInstall(inst.id)
    } else if (id === 'dismiss-error') {
      sessionStore.clearErrorInstance(inst.id)
    }
  }

  function closeMenu(): void {
    ctxMenu.value.open = false
  }

  return {
    ctxMenu,
    ctxMenuItems,
    openCardMenu,
    openActionMenu,
    handleCtxMenuSelect,
    closeMenu,
  }
}
