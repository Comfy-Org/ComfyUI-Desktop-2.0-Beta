import { ref } from 'vue'

// Module-level shared state so all components see the same values
const firstUseCompleted = ref<boolean>(false)
const loaded = ref(false)
let loadPromise: Promise<void> | null = null

/** Seed from the panel URL so the first paint can gate on first-use
 *  without waiting for the async `getSetting` IPC round-trip. Main
 *  passes the persisted value synchronously when loading panel.html. */
export function seedLauncherPrefsFromUrl(search: string): void {
  const value = new URLSearchParams(search).get('firstUseCompleted')
  if (value !== 'true' && value !== 'false') return
  firstUseCompleted.value = value === 'true'
  loaded.value = true
}

export function useLauncherPrefs() {
  async function loadPrefs(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      const firstUse = await (window.api.getSetting('firstUseCompleted') as Promise<boolean | undefined>)
      firstUseCompleted.value = firstUse === true
      loaded.value = true
    })()
    return loadPromise
  }

  /**
   * Flip the first-use takeover gate to "complete" after the user finishes
   * the consent + pick flow (Cloud branch: immediately on Cloud-card pick;
   * Local branch: when the chained new-install Tier 3 takeover signals a
   * successful install via close or navigate-list). Mid-flow cancel never
   * calls this — the takeover replays on the next launch.
   *
   * Idempotent: a second call is a no-op if the flag is already set, so
   * close-after-success listeners don't need to dedupe.
   */
  async function markFirstUseCompleted(): Promise<void> {
    if (firstUseCompleted.value) return
    firstUseCompleted.value = true
    await window.api.setSetting('firstUseCompleted', true)
  }

  return {
    firstUseCompleted,
    loaded,
    loadPrefs,
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
  firstUseCompleted.value = false
}
