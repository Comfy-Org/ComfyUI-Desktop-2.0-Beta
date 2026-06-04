import { onMounted, readonly, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialogs } from './useDialogs'
import type { CloudCapacityStatus, CloudUserTier } from '../types/ipc'

// Boot-time cloud capacity-protection status for the Cloud entry points.
// Loaded once per process (shared `loadPromise`), no mid-session refresh.
// The only flag relaxation is "known paid user" (a kill-switch should shed
// new free traffic, not block existing payers). Fails-closed to 'normal'.
const status = ref<CloudCapacityStatus>('normal')
const userTier = ref<CloudUserTier>('unknown')
let loadPromise: Promise<void> | null = null

// Resolves the capacity-fetch bridge from whichever preload is present
// (`window.api` in panel contexts, `__comfyTitlePopup` in the IPP popup).
// Returns null when neither exists so the caller fail-closes.
interface CapacitySource {
  getCloudCapacity: () => Promise<unknown>
  getCloudUserTier?: () => Promise<unknown>
}
function resolveCapacitySource(): CapacitySource | null {
  const w = window as unknown as {
    api?: { getCloudCapacity?: () => Promise<unknown>; getCloudUserTier?: () => Promise<unknown> }
    __comfyTitlePopup?: {
      getCloudCapacity?: () => Promise<unknown>
      getCloudUserTier?: () => Promise<unknown>
    }
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
    const source = resolveCapacitySource()
    if (!source) return
    // Capacity + tier in parallel; each fails-closed independently.
    const [capacityResult, tierResult] = await Promise.allSettled([
      source.getCloudCapacity(),
      source.getCloudUserTier ? source.getCloudUserTier() : Promise.resolve('unknown'),
    ])
    if (capacityResult.status === 'fulfilled') {
      const next = capacityResult.value
      if (next === 'normal' || next === 'degraded' || next === 'disabled') {
        status.value = next
      }
    }
    if (tierResult.status === 'fulfilled') {
      const tier = tierResult.value
      if (tier === 'free' || tier === 'paid' || tier === 'unknown') {
        userTier.value = tier
      }
    }
  })()
  return loadPromise
}

export function useCloudCapacity(): {
  status: Readonly<typeof status>
  tier: Readonly<typeof userTier>
  isDegraded: () => boolean
  isDisabled: () => boolean
  isBlockingOrWarning: () => boolean
  isPaid: () => boolean
  /** The status the gate actually uses (after the paid-user relaxation).
   *  Use this for visual state so the UI matches `confirmEntry`. */
  effectiveStatus: () => CloudCapacityStatus
  /** Gate Cloud entry. Awaits the boot fetch; `degraded` shows a confirm,
   *  `disabled` returns false. Paid users see `disabled` as `degraded`. */
  confirmEntry: () => Promise<boolean>
  /** Resolves once the boot fetch settles; never rejects. */
  whenReady: () => Promise<void>
} {
  const dialogs = useDialogs()
  const { t } = useI18n()

  onMounted(() => {
    void ensureLoaded()
  })

  // Shared by confirmEntry + effectiveStatus so visual state matches the gate.
  function computeEffective(): CloudCapacityStatus {
    return status.value === 'disabled' && userTier.value === 'paid' ? 'degraded' : status.value
  }

  async function confirmEntry(): Promise<boolean> {
    // Wait for the boot fetch so we never gate on a stale 'normal'.
    await ensureLoaded()
    const effective = computeEffective()
    if (effective === 'disabled') return false
    if (effective !== 'degraded') return true
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
    tier: readonly(userTier) as Readonly<typeof userTier>,
    isDegraded: () => status.value === 'degraded',
    // Reports the RAW flag (kill-switch engaged); for UI greying use
    // the tier-aware `effectiveStatus`.
    isDisabled: () => status.value === 'disabled',
    isBlockingOrWarning: () => status.value !== 'normal',
    isPaid: () => userTier.value === 'paid',
    effectiveStatus: computeEffective,
    confirmEntry,
    whenReady: ensureLoaded,
  }
}
