import { ref, type Ref, type ShallowRef } from 'vue'

/** Persisted one-time flag set when the coachmark is first dismissed. */
export const CENTRAL_PILL_HINT_SEEN_KEY = 'hasSeenCentralPillHint'

interface CoachmarkBridge {
  /** Show the coachmark popup; `leftX`/`rightX`/`bottomY` are title-bar-local px. */
  showCoachmark: (payload: {
    title: string
    body: string
    dismissLabel: string
    leftX: number
    rightX: number
    bottomY: number
  }) => void
  hideCoachmark: () => void
}

interface UseCentralPillCoachmarkOpts {
  bridge: CoachmarkBridge | undefined
  /** The dashboard already IS the picker, so the hint is pointless there. */
  isInstallLess: Ref<boolean>
  /** The pill is non-interactive mid-bootstrap, so don't point at it. */
  isFirstUseLockdown: Ref<boolean>
  /** Wait out a ProgressModal takeover so the hint fires over real ComfyUI, not the loader. */
  isLoadingLockdown?: Ref<boolean>
  installPillRef: Readonly<ShallowRef<HTMLElement | null>>
  /** Resolved coachmark copy (i18n done by the caller). */
  title: string
  body: string
  dismissLabel: string
}

interface CentralPillCoachmarkApi {
  /** Evaluate the gate and show the coachmark once if it passes. */
  maybeShow: () => Promise<void>
  /** Persist the seen flag and hide. Idempotent. */
  dismiss: () => Promise<void>
  /** Opening the pill drawer counts as acknowledgement; same as `dismiss`. */
  acknowledgeViaPillOpen: () => Promise<void>
  /** `true` between show and dismiss; drives the pill highlight. */
  isShowing: Ref<boolean>
}

/**
 * First-instance coachmark pointing at the central pill, shown once ever. Owns the
 * gate, persistence, anchoring, and dismiss wiring; the visual lives in the main-side
 * popup, so this stays unit-testable without a WebContentsView.
 */
export function useCentralPillCoachmark(
  opts: UseCentralPillCoachmarkOpts
): CentralPillCoachmarkApi {
  const isShowing = ref(false)
  // Session guards so show/dismiss stick before the async `setSetting` round-trips.
  let hasCoachmarkShown = false
  let hasCoachmarkRetired = false

  async function isSeen(): Promise<boolean> {
    if (hasCoachmarkRetired) return true
    try {
      const v = await (window.api.getSetting(CENTRAL_PILL_HINT_SEEN_KEY) as Promise<
        boolean | undefined
      >)
      return v === true
    } catch {
      // Read failed; treat as unseen so the hint still gets a chance.
      return false
    }
  }

  function gatePasses(): boolean {
    return (
      !opts.isInstallLess.value &&
      !opts.isFirstUseLockdown.value &&
      !opts.isLoadingLockdown?.value
    )
  }

  async function maybeShow(): Promise<void> {
    if (!opts.bridge) return
    if (hasCoachmarkShown || hasCoachmarkRetired) return
    if (!gatePasses() || !opts.installPillRef.value) return
    if (await isSeen()) return
    // Re-check after the async read; the host could have flipped state while awaiting.
    const pill = opts.installPillRef.value
    if (!gatePasses() || !pill) return

    const rect = pill.getBoundingClientRect()
    hasCoachmarkShown = true
    isShowing.value = true
    opts.bridge.showCoachmark({
      title: opts.title,
      body: opts.body,
      dismissLabel: opts.dismissLabel,
      leftX: Math.round(rect.left),
      rightX: Math.round(rect.right),
      bottomY: Math.round(rect.bottom)
    })
  }

  async function retire(): Promise<void> {
    isShowing.value = false
    if (hasCoachmarkRetired) return
    hasCoachmarkRetired = true
    opts.bridge?.hideCoachmark()
    try {
      await window.api.setSetting(CENTRAL_PILL_HINT_SEEN_KEY, true)
    } catch {
      // Persistence failed; a future launch re-offers the hint.
    }
  }

  return {
    maybeShow,
    dismiss: retire,
    acknowledgeViaPillOpen: retire,
    isShowing
  }
}
