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

/**
 * Outcome of a `performChooserLaunch()` call. Distinguishes the three
 * post-launch states so callers (e.g. the first-use takeover) can react
 * appropriately — `'launched'` will swap a takeover for the
 * connect-progress overlay automatically, but `'focused-running'` and
 * `'missing-action'` leave the slot untouched and require the caller to
 * dismiss the takeover explicitly.
 */
export type ChooserLaunchOutcome = 'focused-running' | 'launched' | 'missing-action'

export interface ChooserHandoffApi {
  /** Prepares the install-less chooser host for an op hand-off — see
   *  function comment for the in-place attach + close-on-instance-started
   *  fallback. Exported separately so `usePanelOverlays.handleShowProgress`
   *  can claim the host for any chooser-originated op (launch, install,
   *  update, migrate, copy, load-snapshot-as-new). Pass
   *  `triggersInstanceStart: false` for non-launch ops to skip the
   *  fallback close-on-instance-started subscription. */
  prepareChooserHostHandoff: (
    installationId: string,
    triggersInstanceStart?: boolean,
  ) => Promise<void>
  /** Shared launch path for chooser-tile clicks AND the first-use
   *  takeover's auto-launch. Returns the outcome so callers can dismiss
   *  any orphaned overlay when launch short-circuits. */
  performChooserLaunch: (
    installation: Installation,
    onMissingLaunchAction?: () => void,
  ) => Promise<ChooserLaunchOutcome>
  /** Bound to ChooserView's `pick` emit. */
  handleChooserPick: (installation: Installation) => Promise<void>
  /** Bound to ChooserView's `show-new-install` empty-state CTA. */
  handleChooserShowNewInstall: () => void
  /** Picker-popover variant of `performChooserLaunch`: same
   *  already-running / launch-action lookup / `useListAction` dispatch,
   *  but WITHOUT `prepareChooserHostHandoff` — the picker is invoked
   *  from an install-backed host that must not be swapped out from
   *  under the user. Launch lands in a fresh Comfy window for the
   *  picked install instead. */
  performPickerLaunch: (installation: Installation) => Promise<ChooserLaunchOutcome>
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

  /** Prepare the chooser host for an op hand-off. First try to claim
   *  the host for in-place attach: when the install eventually becomes
   *  install-backed (`onLaunch` consumes the claim on launch), the
   *  install is attached to THIS host window instead of constructing a
   *  fresh one (`rebuildComfyViewIfNeeded` handles partition mismatches
   *  by swapping the comfyView, so even unique-partition installs reuse
   *  this host). If the claim is rejected — only happens when the panel
   *  webContents isn't registered against any chooser host (race during
   *  construction, or this composable being used outside an install-less
   *  host) — fall back to stamping the chooser host's current bounds onto
   *  the install's saved-bounds slot so its freshly-constructed window
   *  opens at the chooser's position.
   *
   *  When `triggersInstanceStart` is true (launch-class ops) AND the
   *  claim was rejected, additionally subscribe to the resulting
   *  `instance-started` broadcast so this chooser host closes itself
   *  when the new comfy window opens. Non-launch ops (install / update /
   *  migrate / copy / load-snapshot-as-new) don't subscribe — they end
   *  in this host directly (claim path) or leave the chooser intact
   *  (fallback path; the resulting install is launchable later from the
   *  same host). */
  async function prepareChooserHostHandoff(
    installationId: string,
    triggersInstanceStart = true,
  ): Promise<void> {
    // Drop any prior fallback subscription unconditionally. Without this,
    // a previous launch that was claimed by main (no fallback fired) or
    // failed mid-flight would leave its listener live, and a later
    // unrelated `instance-started` could close this chooser host.
    pendingPickUnsub?.()
    pendingPickUnsub = null
    const claimed = await window.api.claimAttachHost(installationId)
    if (claimed) return
    // Visual continuity — stamp the chooser host's current bounds onto
    // the install's saved-bounds slot so its freshly-constructed window
    // opens at the chooser's position.
    await window.api.transferHostBoundsToInstall(installationId)
    if (!triggersInstanceStart) return
    // Subscribe BEFORE kicking off the launch so we don't miss a fast-
    // firing instance-started broadcast. The launch action runs via the
    // ProgressModal pipeline (showProgress: true) so executeAction
    // returns immediately after kicking it off — the actual completion
    // signal is the instance-started event coming back from main.
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
  ): Promise<ChooserLaunchOutcome> {
    if (sessionStore.isRunning(installation.id)) {
      // Focus the running window and leave the chooser host alive
      // (tile clicks transform the host the user clicked from instead
      // of closing it). The chooser host has no install backing it,
      // so there's no detach to do; the surplus window is the price
      // of keeping the user's panel context intact.
      await window.api.focusComfyWindow(installation.id)
      return 'focused-running'
    }
    const actions = await window.api.getListActions(installation.id)
    const launchAction = actions.find((a) => a.id === 'launch')
      ?? actions.find((a) => a.style === 'primary')
      ?? null
    if (!launchAction) {
      onMissingLaunchAction()
      return 'missing-action'
    }
    // Stake the in-place attach claim only after `executeChooserAction`'s
    // guard chain has committed to running. If the user cancels the
    // "operation in progress" prompt (e.g. a sibling chooser window
    // already started this install), staking pre-guard would have
    // cross-window overwritten the sibling's claim AND left this
    // window's title bar showing the install's preview chrome — so
    // when the sibling's launch completed, main would consume *this*
    // window's stale claim and attach the install to the wrong window.
    await executeChooserAction(installation, launchAction, {
      onGuardsPassed: () => prepareChooserHostHandoff(installation.id),
    })
    return 'launched'
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

  /** Picker-popover launch path. Same shape as `performChooserLaunch`
   *  but skips `prepareChooserHostHandoff` so the host that opened the
   *  picker is preserved — the picked install opens in its own fresh
   *  Comfy window via the existing `onLaunch` flow.
   *
   *  Main already handles the focus-if-running short-circuit before
   *  forwarding the IPC, so this composable only sees pick events for
   *  installs that aren't currently running. The already-running guard
   *  remains as belt-and-braces for the race window where main has
   *  already forwarded the IPC but the install transitioned to
   *  running before we got here. */
  async function performPickerLaunch(
    installation: Installation,
  ): Promise<ChooserLaunchOutcome> {
    if (sessionStore.isRunning(installation.id)) {
      await window.api.focusComfyWindow(installation.id)
      return 'focused-running'
    }
    const actions = await window.api.getListActions(installation.id)
    const launchAction = actions.find((a) => a.id === 'launch')
      ?? actions.find((a) => a.style === 'primary')
      ?? null
    if (!launchAction) return 'missing-action'
    await executeChooserAction(installation, launchAction)
    return 'launched'
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
    performPickerLaunch,
  }
}
