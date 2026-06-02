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
 * `unknown`) — paying users get relaxed gating on dashboard / IPP so a
 * launch-week kill-switch doesn't deny the product to people who pay
 * for it. See `main/lib/userTier.ts` for the source-of-truth fetch path.
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
  /** What the gate would do for `surface` right now, after applying
   *  the first-use + paid-tier relaxations. Use this for visual state
   *  (chip copy, greying) so the UI matches what `confirmEntry` will
   *  actually do — otherwise a paid user sees a "Temporarily
   *  unavailable" tile that lets them through, or vice versa. */
  effectiveStatus: (surface: 'first-use' | 'dashboard' | 'ipp') => CloudCapacityStatus
  /** Gate every Cloud entry action through this. Awaits the boot-time
   *  fetch first, so an action fired before the IPC settles still sees
   *  the resolved value (not the stale `'normal'` default). Returns:
   *   - `normal`   → resolves `true` immediately (post-load), no UI.
   *   - `degraded` → shows a confirm modal explaining heavy usage;
   *                  resolves `true` only on the user's confirm.
   *   - `disabled` → resolves `false` (defense-in-depth; surface also
   *                  greys/blocks at the click level).
   *
   *  Two relaxations soften `disabled` into the `degraded` heads-up
   *  modal instead of hard-blocking:
   *   1. `surface: 'first-use'` — first-use runs pre-sign-in, so we
   *      can't tell paid users from free here; blocking everyone on a
   *      fresh install during launch-week overload is worse than
   *      letting them proceed with a clear heads-up.
   *   2. signed-in `paid` users on any surface — a launch-week kill-
   *      switch should shed *new free* traffic, not deny the product
   *      to people who already pay for it. `unknown` tier (no fetch
   *      yet this lifetime) is treated as `free`, fails-closed. */
  confirmEntry: (opts?: { surface?: 'first-use' | 'dashboard' | 'ipp' }) => Promise<boolean>
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
  function computeEffective(surface: 'first-use' | 'dashboard' | 'ipp'): CloudCapacityStatus {
    const softenDisabled = surface === 'first-use' || userTier.value === 'paid'
    return status.value === 'disabled' && softenDisabled ? 'degraded' : status.value
  }

  async function confirmEntry(opts: { surface?: 'first-use' | 'dashboard' | 'ipp' } = {}): Promise<boolean> {
    // Wait for the boot fetch so we never gate on a stale 'normal'.
    await ensureLoaded()
    const effective = computeEffective(opts.surface ?? 'dashboard')
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
    // effective check below.
    isDisabled: () => status.value === 'disabled',
    isBlockingOrWarning: () => status.value !== 'normal',
    isPaid: () => userTier.value === 'paid',
    effectiveStatus: computeEffective,
    confirmEntry,
    whenReady: ensureLoaded,
  }
}
