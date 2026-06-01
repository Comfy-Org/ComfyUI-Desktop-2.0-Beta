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
 * `main/lib/cloudCapacity.ts`). The status is loaded once per renderer
 * mount and held in a process-local ref; there is intentionally no
 * mid-session refresh.
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
  /** Gate every Cloud entry action through this. Returns `true` when
   *  the caller may proceed:
   *   - `normal`   → resolves `true` immediately, no UI.
   *   - `degraded` → shows a confirm modal explaining heavy usage;
   *                  resolves `true` only on the user's confirm.
   *   - `disabled` → resolves `false` immediately (defense-in-depth;
   *                  the UI also greys/blocks at the surface level). */
  confirmEntry: () => Promise<boolean>
} {
  const dialogs = useDialogs()
  const { t } = useI18n()

  onMounted(() => {
    void loadOnce()
  })

  async function confirmEntry(): Promise<boolean> {
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
