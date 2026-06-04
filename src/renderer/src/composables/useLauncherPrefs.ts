import { ref } from 'vue'

// Module-level shared state so all components see the same values.
const firstUseCompleted = ref<boolean>(false)
const loaded = ref(false)
let loadPromise: Promise<void> | null = null

// Seed from the panel URL so first paint can gate without the async getSetting IPC.
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

  // Marks first-use complete after the consent + pick flow succeeds (never on
  // mid-flow cancel). Idempotent.
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

// Test-only: clear the memoized load promise + refs so loadPrefs re-reads.
export function __resetLauncherPrefsForTest(): void {
  loadPromise = null
  loaded.value = false
  firstUseCompleted.value = false
}
