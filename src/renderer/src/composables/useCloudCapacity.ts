import { onMounted, readonly, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialogs } from './useDialogs'
import type { CloudCapacityStatus } from '../types/ipc'

/**
 * Read the boot-time cloud capacity-protection status from main and
 * expose a small reactive surface for the three Cloud entry points
 * (dashboard tile, first-use Cloud-or-Local pick, instance-picker
 * popup).
 *
 * Backed by the `desktop-cloud-capacity` PostHog flag, resolved in main
 * at boot via the OPS-flag fetch path (consent-bypassed by design — see
 * `main/lib/cloudCapacity.ts`). The status is loaded once per process
 * (shared `loadPromise` across composable instances) and held in a
 * process-local ref; there is intentionally no mid-session refresh.
 *
 * Always returns `'normal'` until the first IPC call resolves, and
 * fails-closed-to-normal on any error so a broken flag-fetch never
 * accidentally degrades or blocks the cloud entry points.
 */
const status = ref<CloudCapacityStatus>('normal')
let loadPromise: Promise<void> | null = null

/**
 * Resolve the capacity-fetch entry point. The composable runs in two
 * different renderer contexts with different preloads:
 *   - Panel / dashboard / first-use: `window.api.getCloudCapacity` from
 *     the main `comfyPreload`.
 *   - IPP popup (own WebContentsView): no `window.api`; uses the popup
 *     bridge `window.__comfyTitlePopup.getCloudCapacity` from
 *     `comfyTitlePopupPreload`. Both forward to the same `ipcMain`
 *     handler, so the resolved value is identical.
 * Returns `null` if neither surface is present (test envs, broken
 * preload) so the caller fail-closes to `'normal'`.
 */
interface CapacitySource {
  getCloudCapacity: () => Promise<unknown>
}
function resolveCapacitySource(): CapacitySource | null {
  const w = window as unknown as {
    api?: { getCloudCapacity?: () => Promise<unknown> }
    __comfyTitlePopup?: { getCloudCapacity?: () => Promise<unknown> }
  }
  if (w.api && typeof w.api.getCloudCapacity === 'function') {
    return w.api as CapacitySource
  }
  if (w.__comfyTitlePopup && typeof w.__comfyTitlePopup.getCloudCapacity === 'function') {
    return w.__comfyTitlePopup as CapacitySource
  }
  return null
}

function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const source = resolveCapacitySource()
      if (!source) return
      const next = await source.getCloudCapacity()
      if (next === 'normal' || next === 'degraded' || next === 'disabled') {
        status.value = next
      }
    } catch {
      // fail-closed: stay on 'normal'
    }
  })()
  return loadPromise
}

export function useCloudCapacity(): {
  status: Readonly<typeof status>
  isDegraded: () => boolean
  isDisabled: () => boolean
  isBlockingOrWarning: () => boolean
  /** Gate every Cloud entry action through this. Awaits the boot-time
   *  fetch first, so an action fired before the IPC settles still sees
   *  the resolved value (not the stale `'normal'` default). Returns:
   *   - `normal`   → resolves `true` immediately (post-load), no UI.
   *   - `degraded` → shows a confirm modal explaining heavy usage;
   *                  resolves `true` only on the user's confirm.
   *   - `disabled` → resolves `false` (defense-in-depth; surface also
   *                  greys/blocks at the click level). */
  confirmEntry: () => Promise<boolean>
} {
  const dialogs = useDialogs()
  const { t } = useI18n()

  onMounted(() => {
    void ensureLoaded()
  })

  async function confirmEntry(): Promise<boolean> {
    // Wait for the boot fetch so we never gate on a stale 'normal'.
    await ensureLoaded()
    if (status.value === 'disabled') return false
    if (status.value !== 'degraded') return true
    const result = await dialogs.confirm({
      title: t('cloud.capacityDegraded'),
      message: t('cloud.capacityDegradedHint'),
      confirmLabel: t('cloud.capacityProceed'),
      cancelLabel: t('common.cancel'),
      tone: 'primary',
    })
    return result === 'primary'
  }

  return {
    status: readonly(status) as Readonly<typeof status>,
    isDegraded: () => status.value === 'degraded',
    isDisabled: () => status.value === 'disabled',
    isBlockingOrWarning: () => status.value !== 'normal',
    confirmEntry,
  }
}
