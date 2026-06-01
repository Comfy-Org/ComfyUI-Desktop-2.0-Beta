import { onMounted, readonly, ref } from 'vue'
import type { CloudCapacityStatus } from '../types/ipc'

/**
 * Read the boot-time cloud capacity-protection status from main and
 * expose a small reactive surface for the three Cloud entry points
 * (dashboard tile, install wizard, instance-picker popup).
 *
 * Backed by the `desktop-cloud-capacity` PostHog flag, resolved in main
 * at boot via the experiments cache. Status is loaded once per renderer
 * mount and held in a process-local ref — there is intentionally no
 * mid-session refresh path. See `src/main/lib/cloudCapacity.ts` for the
 * trade-off and consent caveats.
 *
 * Always returns `'normal'` until the first IPC call resolves, and
 * fails-closed-to-normal on any error so a broken flag-fetch never
 * accidentally degrades or blocks the cloud entry points.
 */
const status = ref<CloudCapacityStatus>('normal')
let loaded = false

async function loadOnce(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const next = await window.api.getCloudCapacity()
    if (next === 'normal' || next === 'degraded' || next === 'disabled') {
      status.value = next
    }
  } catch {
    // fail-closed: stay on 'normal'
  }
}

export function useCloudCapacity(): {
  status: Readonly<typeof status>
  isDegraded: () => boolean
  isDisabled: () => boolean
  isBlockingOrWarning: () => boolean
} {
  onMounted(() => {
    void loadOnce()
  })
  return {
    status: readonly(status) as Readonly<typeof status>,
    isDegraded: () => status.value === 'degraded',
    isDisabled: () => status.value === 'disabled',
    isBlockingOrWarning: () => status.value !== 'normal',
  }
}
