import { onUnmounted } from 'vue'
import { useListAction } from '../composables/useListAction'
import { useSessionStore } from '../stores/sessionStore'
import type { Installation, ShowProgressOpts } from '../types/ipc'
import type { PanelKey } from './usePanelOverlays'

export interface ChooserHandoffOpts {
  /** Forwards the chooser's launch action through the shared
   *  Tier 2 progress / Tier 3 takeover routing in `usePanelOverlays`. */
  showProgress: (opts: ShowProgressOpts) => Promise<void>
  /** Used by the chooser empty-state CTA and by the missing-launch-
   *  action fallback in `handleChooserPick` to surface the new-install
   *  flow as a Tier 3 takeover above the chooser body. */
  switchPanel: (panel: PanelKey, entrypoint?: string) => Promise<void>
}

export interface ChooserHandoffApi {
  /** Prepares the install-less chooser host for a launch hand-off — see
   *  function comment for the in-place attach + close-on-instance-started
   *  fallback. Exported separately so `usePanelOverlays.handleShowProgress`
   *  can subscribe when a launch-class op originates outside the chooser
   *  pipeline (e.g. DetailModal). */
  prepareChooserHostHandoff: (installationId: string) => Promise<void>
  /** Shared launch path for chooser-tile clicks AND the first-use
   *  takeover's auto-launch. */
  performChooserLaunch: (
    installation: Installation,
    onMissingLaunchAction?: () => void,
  ) => Promise<void>
  /** Bound to ChooserView's `pick` emit. */
  handleChooserPick: (installation: Installation) => Promise<void>
  /** Bound to ChooserView's `show-new-install` empty-state CTA. */
  handleChooserShowNewInstall: () => void
}

/**
 * Owns the install-less chooser host's launch hand-off — the
 * sequence that turns a chooser-tile click (or any
 * `triggersInstanceStart` op originating from this host) into a
 * running ComfyUI window. The launch UX paths reuse `useListAction`
 * so the chooser shares the Dashboard's confirm modal / port-conflict
 * resolution / telemetry behaviour.
 *
 * `prepareChooserHostHandoff` is exposed independently so
 * `usePanelOverlays.handleShowProgress` can call it for surfaces
 * (DetailModal etc.) that route launches straight through
 * `show-progress` without going through `performChooserLaunch`.
 */
export function useChooserHandoff(opts: ChooserHandoffOpts): ChooserHandoffApi {
  const sessionStore = useSessionStore()
  const { executeAction: executeChooserAction } = useListAction('chooser', {
    showProgress: opts.showProgress,
  })

  /** Pending close-on-launch subscription (fallback). Only set when
   *  the in-place attach claim is rejected by main and the chooser
   *  host falls back to the close+open swap. Cleaned up on unmount
   *  to avoid leaking the listener if the host tears down before
   *  `instance-started` lands. */
  let pendingPickUnsub: (() => void) | null = null

  /** Prepare the chooser host for a launch hand-off. First try to
   *  claim the host for in-place attach: when the launch event lands
   *  in main, `onLaunch` will attach the install to THIS host window
   *  instead of constructing a fresh one. If the claim is rejected
   *  (e.g. the install needs a unique browser partition), fall back
   *  to the stamp-bounds + close-on-instance-started swap so the user
   *  still gets the install's window at the chooser's bounds. */
  async function prepareChooserHostHandoff(installationId: string): Promise<void> {
    const claimed = await window.api.claimAttachHost(installationId)
    if (claimed) return
    // Visual continuity — stamp the chooser host's current bounds onto
    // the install's saved-bounds slot so its freshly-constructed window
    // opens at the chooser's position.
    await window.api.transferHostBoundsToInstall(installationId)
    // Subscribe BEFORE kicking off the launch so we don't miss a fast-
    // firing instance-started broadcast. The launch action runs via the
    // ProgressModal pipeline (showProgress: true) so executeAction
    // returns immediately after kicking it off — the actual completion
    // signal is the instance-started event coming back from main.
    pendingPickUnsub?.()
    pendingPickUnsub = window.api.onInstanceStarted((data) => {
      if (data.installationId !== installationId) return
      pendingPickUnsub?.()
      pendingPickUnsub = null
      // The install's own ComfyUI window has opened — chooser host is done.
      void window.api.closeHostWindow()
    })
  }

  /** Shared launch path for chooser-tile clicks AND the first-use
   *  takeover's auto-launch. Both surfaces want the same five-step
   *  shape (already-running short-circuit → resolve launch action →
   *  in-place attach claim → executeAction). One helper so a future
   *  change to the launch UX can't regress one surface but not the
   *  other.
   *
   *  `onMissingLaunchAction` is the only thing that diverges:
   *    - chooser tile click → fall back to the new-install flow inside
   *      this host (the user picked a tile that has no launch path
   *      because the install isn't yet installed).
   *    - first-use auto-launch → silently no-op (the chained new-install
   *      op already finished, anything missing is genuinely "no
   *      launchable install" and we don't want to bounce the user back
   *      into a wizard immediately after they finished one). */
  async function performChooserLaunch(
    installation: Installation,
    onMissingLaunchAction: () => void = () => {},
  ): Promise<void> {
    if (sessionStore.isRunning(installation.id)) {
      // Focus the running window and leave the chooser host alive
      // (tile clicks transform the host the user clicked from instead
      // of closing it). The chooser host has no install backing it,
      // so there's no detach to do; the surplus window is the price
      // of keeping the user's panel context intact.
      await window.api.focusComfyWindow(installation.id)
      return
    }
    const actions = await window.api.getListActions(installation.id)
    const launchAction = actions.find((a) => a.id === 'launch')
      ?? actions.find((a) => a.style === 'primary')
      ?? null
    if (!launchAction) {
      onMissingLaunchAction()
      return
    }
    await prepareChooserHostHandoff(installation.id)
    await executeChooserAction(installation, launchAction)
  }

  async function handleChooserPick(installation: Installation): Promise<void> {
    // Already-running short-circuit, launch-action lookup, and in-place
    // attach claim all live in `performChooserLaunch`. Tile-click
    // semantics for the missing-launch-action case: bounce into the
    // new-install flow inside this same host so the user can resolve
    // the missing setup step without bouncing to a separate window.
    await performChooserLaunch(installation, () => {
      void opts.switchPanel('new-install', 'chooser_pick')
    })
  }

  function handleChooserShowNewInstall(): void {
    // Empty-state CTA from the chooser — opens the new-install flow as
    // a Tier 3 takeover above the chooser body. Same install-less host
    // window; the user perceives a wizard step rather than a navigation
    // jump, and dismissing the takeover drops them right back into the
    // chooser tile they came from.
    void opts.switchPanel('new-install', 'chooser')
  }

  onUnmounted(() => {
    pendingPickUnsub?.()
  })

  return {
    prepareChooserHostHandoff,
    performChooserLaunch,
    handleChooserPick,
    handleChooserShowNewInstall,
  }
}
