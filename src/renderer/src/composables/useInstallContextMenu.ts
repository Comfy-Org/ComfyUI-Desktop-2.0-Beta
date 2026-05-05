import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLauncherPrefs } from './useLauncherPrefs'
import { useSessionStore } from '../stores/sessionStore'
import type { ContextMenuItem } from '../types/context-menu'
import type { Installation } from '../types/ipc'

/**
 * Right-click context menu for chooser tiles. Today exposes:
 *
 *   - Pin / Unpin (non-cloud installs only)
 *   - Dismiss error (when the install has a stored error)
 *
 * The previous "View Details" item routed through `handleChooserShowDetail`
 * which fell through to `handleChooserPick` — i.e. it launched the install
 * instead of just opening Install Settings. The right fix is a
 * non-launching `open-install-host-window-on-panel(installationId, panel)`
 * IPC that creates an install-backed host window without booting ComfyUI;
 * tracked separately so we don't ship the broken "View Details" entry in
 * the meantime.
 */
export function useInstallContextMenu() {
  const { t } = useI18n()
  const prefs = useLauncherPrefs()
  const sessionStore = useSessionStore()

  const ctxMenu = ref({ open: false, x: 0, y: 0, inst: null as Installation | null })

  function getMenuItems(inst: Installation): ContextMenuItem[] {
    const items: ContextMenuItem[] = []

    if (inst.sourceCategory !== 'cloud') {
      items.push({
        id: prefs.isPinned(inst.id) ? 'unpin' : 'pin',
        label: prefs.isPinned(inst.id) ? t('dashboard.unpinFromDashboard') : t('dashboard.pinToDashboard'),
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

  function openCardMenu(event: MouseEvent, inst: Installation): void {
    const items = getMenuItems(inst)
    if (items.length === 0) return
    event.preventDefault()
    ctxMenu.value = { open: true, x: event.clientX, y: event.clientY, inst }
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
    handleCtxMenuSelect,
    closeMenu,
  }
}
