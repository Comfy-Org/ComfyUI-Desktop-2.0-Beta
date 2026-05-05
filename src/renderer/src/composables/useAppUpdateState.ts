import { ref, onMounted, type Ref } from 'vue'
import { useElectronApi } from './useElectronApi'
import type { UpdateInfo, UpdateDownloadProgress } from '../types/ipc'

/**
 * Phase 3 §18 — shared app-update state for `UpdateBanner` and the
 * title-bar app-update popover (`PanelApp.vue`'s `app-update`
 * overlay branch). Both surfaces consume the same reactive `state`
 * ref so they cannot disagree about whether an update is available
 * / ready / downloading / errored.
 *
 * Lives in a composable rather than a Pinia store because:
 *   - The state is push-only (driven by main's broadcast pipeline);
 *     no actions need to be coordinated between consumers.
 *   - Each PanelApp instance owns its own slice — the banner and the
 *     popover live inside the same panel renderer, so a per-mount
 *     subscription is the right scope. Multiple PanelApp windows
 *     each get their own copy, which matches how the banner used
 *     to work pre-§18.
 *
 * Shape mirrors the pre-§18 inline state in `UpdateBanner.vue` so
 * the refactor is a pure dedup — no behaviour change.
 */
export type AppUpdateState =
  | { type: 'available'; version: string }
  | { type: 'downloading'; transferred: string; total: string; percent: number }
  | { type: 'ready'; version: string }
  | { type: 'error'; message: string }

export interface UseAppUpdateStateApi {
  /** Current update state (or null when nothing is pending). */
  state: Ref<AppUpdateState | null>
  /** Whether the install supports auto-update (false on system-package
   *  Linux installs — .deb/.rpm). Drives the "Download" button. */
  canAutoUpdate: Ref<boolean>
  /** Whether this is a system-managed install (Linux .deb/.rpm).
   *  Drives the alternative copy ("update via package manager"). */
  systemManaged: Ref<boolean>
  /** Manually clear the local state — banner dismiss / retry. The
   *  underlying updater state in main is unaffected, so a fresh
   *  broadcast (e.g. from the next auto-check) will repopulate. */
  clear: () => void
}

export function useAppUpdateState(): UseAppUpdateStateApi {
  const { api, listen } = useElectronApi()

  const state = ref<AppUpdateState | null>(null)
  const canAutoUpdate = ref(true)
  const systemManaged = ref(false)

  function clear(): void {
    state.value = null
  }

  listen<UpdateInfo>(api.onUpdateAvailable, (info) => {
    state.value = { type: 'available', version: info.version }
  })

  listen<UpdateDownloadProgress>(api.onUpdateDownloadProgress, (progress) => {
    state.value = {
      type: 'downloading',
      transferred: progress.transferred,
      total: progress.total,
      percent: progress.percent,
    }
  })

  listen<UpdateInfo>(api.onUpdateDownloaded, (info) => {
    state.value = { type: 'ready', version: info.version }
  })

  listen<{ message: string }>(api.onUpdateError, (err) => {
    state.value = { type: 'error', message: err.message }
  })

  onMounted(async () => {
    const caps = await api.getUpdateCapabilities()
    canAutoUpdate.value = caps.canAutoUpdate
    systemManaged.value = caps.systemManaged
    const pending = await api.getPendingUpdate()
    if (pending) {
      state.value = { type: 'ready', version: pending.version }
    }
  })

  return { state, canAutoUpdate, systemManaged, clear }
}
