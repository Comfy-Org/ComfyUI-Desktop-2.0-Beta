import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLauncherPrefs } from './useLauncherPrefs'
import { useSessionStore } from '../stores/sessionStore'
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
 * Items today:
 *
 *   - **Pin / Unpin** (non-cloud installs only).
 *   - **Manage…** — opens the install's `DetailModal` overlay so the
 *     user can edit settings, restore snapshots, run actions, etc.
 *     Routed through an `onManage` callback the caller supplies.
 *   - **Dismiss error** (when the install has a stored error).
 *
 * Card click — single click on the tile body — opens the install
 * directly (`@click="pickInstall"` in ChooserView). The kebab button
 * stops propagation so clicking the icon doesn't also fire the
 * card-level open.
 */
export function useInstallContextMenu(opts: {
  /** Called when the user picks "Manage…" from the menu. The caller
   *  is responsible for opening the per-install DetailModal overlay. */
  onManage?: (inst: Installation) => void
} = {}) {
  const { t } = useI18n()
  const prefs = useLauncherPrefs()
  const sessionStore = useSessionStore()

  const ctxMenu = ref({
    open: false,
    x: 0,
    y: 0,
    inst: null as Installation | null,
  })

  function getMenuItems(inst: Installation): ContextMenuItem[] {
    const items: ContextMenuItem[] = []

    if (inst.sourceCategory !== 'cloud') {
      items.push({
        id: prefs.isPinned(inst.id) ? 'unpin' : 'pin',
        label: prefs.isPinned(inst.id) ? t('dashboard.unpinFromDashboard') : t('dashboard.pinToDashboard'),
      })
    }

    if (opts.onManage) {
      items.push({
        id: 'manage',
        label: t('chooser.manageInstall'),
        separator: items.length > 0,
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

  async function handleCtxMenuSelect(id: string): Promise<void> {
    const inst = ctxMenu.value.inst
    if (!inst) return
    if (id === 'pin') {
      await prefs.pinInstall(inst.id)
    } else if (id === 'unpin') {
      await prefs.unpinInstall(inst.id)
    } else if (id === 'manage') {
      opts.onManage?.(inst)
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
    openKebabMenu,
    handleCtxMenuSelect,
    closeMenu,
  }
}
