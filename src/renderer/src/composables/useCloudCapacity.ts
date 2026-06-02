import { onMounted, readonly, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDialogs } from './useDialogs'
import type { CloudCapacityStatus, CloudUserTier } from '../types/ipc'

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
 * Also fetches the signed-in user's subscription tier (`free` / `paid` /
 * `unknown`). The ONLY relaxation on the flag is "known paid user" —
 * a launch-week kill-switch should shed new free traffic, not deny the
 * product to people who already pay for it. Every other case (free,
 * unknown, pre-sign-in) follows the flag verbatim. See
 * `main/lib/userTier.ts` for the source-of-truth fetch path.
 *
 * Always returns `'normal'` until the first IPC call resolves, and
 * fails-closed-to-normal on any error so a broken flag-fetch never
 * accidentally degrades or blocks the cloud entry points.
 */
const status = ref<CloudCapacityStatus>('normal')
const userTier = ref<CloudUserTier>('unknown')
let loadPromise: Promise<void> | null = null

/**
 * Resolve the capacity-fetch entry point. The composable runs in two
 * different renderer contexts with different preloads:
 *   - Panel / dashboard / first-use: `window.api.*` from the main
 *     `comfyPreload`.
 *   - IPP popup (own WebContentsView): no `window.api`; uses the popup
 *     bridge `window.__comfyTitlePopup.*` from `comfyTitlePopupPreload`.
 *     Both forward to the same `ipcMain` handlers.
 * Returns `null` if neither surface is present (test envs, broken
 * preload) so the caller fail-closes to defaults.
 */
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
    // Capacity + tier in parallel — neither blocks the other. Both
    // fail-closed independently so a tier-fetch error doesn't strand
    // the capacity status (and vice versa).
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
  /** The status the gate will actually use, after the paid-user
   *  relaxation. Use this for visual state (chip copy, greying) so the
   *  UI matches what `confirmEntry` will do — otherwise a paid user
   *  sees "Temporarily unavailable" on a tile they can click through.
   *  For free / unknown users, this returns the raw flag value
   *  verbatim. */
  effectiveStatus: () => CloudCapacityStatus
  /** Gate every Cloud entry action through this. Awaits the boot-time
   *  fetch first, so an action fired before the IPC settles still sees
   *  the resolved value (not the stale `'normal'` default). Returns:
   *   - `normal`   → resolves `true` immediately (post-load), no UI.
   *   - `degraded` → shows a confirm modal explaining heavy usage;
   *                  resolves `true` only on the user's confirm.
   *   - `disabled` → resolves `false` (defense-in-depth; surface also
   *                  greys/blocks at the click level).
   *
   *  Single relaxation: signed-in `paid` users see `disabled` as the
   *  `degraded` heads-up modal — a launch-week kill-switch should shed
   *  new free traffic, not deny the product to people who already pay
   *  for it. `unknown` tier (no fetch yet this lifetime) is treated as
   *  `free`, fails-closed. Every other case follows the flag verbatim. */
  confirmEntry: () => Promise<boolean>
  /** Resolves once the boot-time capacity + tier fetch has settled.
   *  Use for pre-render decisions (e.g. the first-use Cloud-vs-Local
   *  default selection) where reading a stale `'normal'` would race
   *  the user's first click. Never rejects — failures fall back to
   *  the safe defaults. */
  whenReady: () => Promise<void>
} {
  const dialogs = useDialogs()
  const { t } = useI18n()

  onMounted(() => {
    void ensureLoaded()
  })

  /** Shared between `confirmEntry` and the `effectiveStatus` helper —
   *  must stay aligned so visual state matches what the gate does. */
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
    // `isDisabled` reports the RAW flag — used by surfaces that want
    // to know whether the kill-switch is engaged (e.g. for telemetry).
    // For "should I grey out the cloud tile?", prefer the tier-aware
    // `effectiveStatus` instead.
    isDisabled: () => status.value === 'disabled',
    isBlockingOrWarning: () => status.value !== 'normal',
    isPaid: () => userTier.value === 'paid',
    effectiveStatus: computeEffective,
    confirmEntry,
    whenReady: ensureLoaded,
  }
}
