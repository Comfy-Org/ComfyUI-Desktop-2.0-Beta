import { ref } from 'vue'

// Module-level shared state so all components see the same values
const pinnedInstallIds = ref<string[]>([])
const loaded = ref(false)
let loadPromise: Promise<void> | null = null

export function useLauncherPrefs() {
  async function loadPrefs(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      const pinned = await window.api.getSetting('pinnedInstallIds') as string[] | undefined
      pinnedInstallIds.value = Array.isArray(pinned) ? pinned : []
      loaded.value = true
    })()
    return loadPromise
  }

  async function pinInstall(id: string): Promise<void> {
    if (!pinnedInstallIds.value.includes(id)) {
      pinnedInstallIds.value = [...pinnedInstallIds.value, id]
    }
    await window.api.runAction(id, 'pin-install')
  }

  async function unpinInstall(id: string): Promise<void> {
    pinnedInstallIds.value = pinnedInstallIds.value.filter((i) => i !== id)
    await window.api.runAction(id, 'unpin-install')
  }

  function isPinned(id: string): boolean {
    return pinnedInstallIds.value.includes(id)
  }

  return {
    pinnedInstallIds,
    loaded,
    loadPrefs,
    pinInstall,
    unpinInstall,
    isPinned,
  }
}
