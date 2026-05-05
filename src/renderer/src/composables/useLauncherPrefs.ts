import { ref } from 'vue'

// Module-level shared state so all components see the same values
const pinnedInstallIds = ref<string[]>([])
const firstUseCompleted = ref<boolean>(false)
const loaded = ref(false)
let loadPromise: Promise<void> | null = null

export function useLauncherPrefs() {
  async function loadPrefs(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      const [pinned, firstUse] = await Promise.all([
        window.api.getSetting('pinnedInstallIds') as Promise<string[] | undefined>,
        window.api.getSetting('firstUseCompleted') as Promise<boolean | undefined>,
      ])
      pinnedInstallIds.value = Array.isArray(pinned) ? pinned : []
      firstUseCompleted.value = firstUse === true
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

  /**
   * Phase 3 §17 Step 4 — flip the first-use takeover gate to "complete"
   * after the user finishes the consent + pick flow (Cloud branch:
   * immediately on Cloud-card pick; Local branch: when the chained
   * new-install Tier 3 takeover signals a successful install via close
   * or navigate-list). Mid-flow cancel never calls this — the takeover
   * replays on the next launch.
   *
   * Idempotent: a second call is a no-op if the flag is already set,
   * so the chain-to-new-install plumbing in PanelApp can listen on
   * close-after-success without worrying about double-fire.
   */
  async function markFirstUseCompleted(): Promise<void> {
    if (firstUseCompleted.value) return
    firstUseCompleted.value = true
    await window.api.setSetting('firstUseCompleted', true)
  }

  return {
    pinnedInstallIds,
    firstUseCompleted,
    loaded,
    loadPrefs,
    pinInstall,
    unpinInstall,
    isPinned,
    markFirstUseCompleted,
  }
}

/**
 * Test-only: clear the module-level memoized load promise + reset all
 * refs so a fresh `loadPrefs()` call re-reads the persisted settings.
 * Production code should never call this — `loadPrefs` is intentionally
 * memoized so all components share one fetched view.
 */
export function __resetLauncherPrefsForTest(): void {
  loadPromise = null
  loaded.value = false
  pinnedInstallIds.value = []
  firstUseCompleted.value = false
}
