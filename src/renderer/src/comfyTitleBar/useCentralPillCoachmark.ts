import { ref, type Ref, type ShallowRef } from 'vue'

/** Persisted one-time flag — set the first time the central-pill
 *  coachmark is dismissed (or the user opens the drawer). Mirrors the
 *  `firstUseCompleted` one-time-flag convention in `useLauncherPrefs`,
 *  but lives here because the title-bar renderer reaches settings via the
 *  shared `window.api` bridge rather than the panel-side prefs singleton. */
export const CENTRAL_PILL_HINT_SEEN_KEY = 'hasSeenCentralPillHint'

interface CoachmarkBridge {
  /** Show the central-pill onboarding coachmark popup. Reuses the
   *  clip-escaping title-popup pipeline; `leftX`/`rightX` bracket the
   *  pill's horizontal edges and `bottomY` is its bottom edge, all in
   *  title-bar-local px (the title-bar view sits at window (0,0)). */
  showCoachmark: (payload: {
    title: string
    body: string
    dismissLabel: string
    leftX: number
    rightX: number
    bottomY: number
  }) => void
  /** Hide the coachmark popup. */
  hideCoachmark: () => void
}

interface UseCentralPillCoachmarkOpts {
  bridge: CoachmarkBridge | undefined
  /** Install-less host (chooser/dashboard) — the dashboard already IS the
   *  picker, so the hint is pointless there. */
  isInstallLess: Ref<boolean>
  /** First-use takeover lockdown — the pill is static/non-interactive,
   *  so never point at it mid-bootstrap. */
  isFirstUseLockdown: Ref<boolean>
  /** Loading-lockdown — a ProgressModal / connect-progress takeover is up
   *  (install / launch / connect). Wait for it to clear so the coachmark
   *  fires only once the actual ComfyUI screen is visible, not over the
   *  brand loader. Optional; absent → treated as never-loading. */
  isLoadingLockdown?: Ref<boolean>
  /** Template ref for the centre install pill — anchors the coachmark. */
  installPillRef: Readonly<ShallowRef<HTMLElement | null>>
  /** Resolved coachmark copy (i18n done by the caller). */
  title: string
  body: string
  dismissLabel: string
}

interface CentralPillCoachmarkApi {
  /** Evaluate the gate and, if it passes, show the coachmark once. */
  maybeShow: () => Promise<void>
  /** Dismiss (✕ / blur): persist the seen flag and hide. Idempotent. */
  dismiss: () => Promise<void>
  /** The user opened the pill drawer — counts as acknowledgement. Same
   *  effect as `dismiss`. */
  acknowledgeViaPillOpen: () => Promise<void>
  /** `true` between show and dismiss/hide — drives the pill's brand-yellow
   *  highlight while the coachmark points at it. */
  isShowing: Ref<boolean>
}

/**
 * First-instance coachmark pointing at the central title-bar pill
 * (issue #701). The first time a user lands in a real instance, a
 * dismissable hint explains the pill is the instance picker. Shown once,
 * ever. Owns the gate, once-ever persistence (`window.api`), anchoring,
 * and dismiss wiring; the visual lives in the main-side popup, so this
 * stays unit-testable without a WebContentsView.
 */
export function useCentralPillCoachmark(
  opts: UseCentralPillCoachmarkOpts
): CentralPillCoachmarkApi {
  /** Drives the pill highlight — true while the coachmark is on screen. */
  const isShowing = ref(false)
  // Session guards so a show / dismiss sticks for this renderer's life
  // even before the async `setSetting` round-trips.
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
      // Read failed — treat as unseen so the hint still gets a chance.
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
    // Re-check gate + pill after the async read — the host could have
    // flipped to install-less / lockdown while we awaited settings.
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
      // Persistence failed — a future launch simply re-offers the hint.
    }
  }

  return {
    maybeShow,
    dismiss: retire,
    acknowledgeViaPillOpen: retire,
    isShowing
  }
}
