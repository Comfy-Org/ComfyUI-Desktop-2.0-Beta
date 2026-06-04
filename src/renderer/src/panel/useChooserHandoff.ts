import { onUnmounted } from 'vue'
import { useListAction } from '../composables/useListAction'
import { useSessionStore } from '../stores/sessionStore'
import type { Installation, ShowProgressOpts } from '../types/ipc'
import type { PanelKey } from './usePanelOverlays'

export interface ChooserHandoffOpts {
  /** Routes the chooser's launch through the shared progress / takeover
   *  routing in `usePanelOverlays`. */
  showProgress: (opts: ShowProgressOpts) => Promise<void>
  /** Surfaces the new-install flow as a takeover above the chooser body. */
  switchPanel: (panel: PanelKey, entrypoint?: string) => Promise<void>
}

/** Outcome of `performChooserLaunch()`. `'launched'` auto-swaps a takeover
 *  for the connect-progress overlay; the other two leave the slot for the
 *  caller to dismiss. */
export type ChooserLaunchOutcome = 'focused-running' | 'launched' | 'missing-action'

export interface ChooserHandoffApi {
  /** Prepares the install-less chooser host for an op hand-off. Pass
   *  `triggersInstanceStart: false` for non-launch ops to skip the
   *  close-on-instance-started fallback subscription. */
  prepareChooserHostHandoff: (
    installationId: string,
    triggersInstanceStart?: boolean,
  ) => Promise<void>
  /** Shared launch path for chooser-tile clicks and first-use auto-launch. */
  performChooserLaunch: (
    installation: Installation,
    onMissingLaunchAction?: () => void,
  ) => Promise<ChooserLaunchOutcome>
  /** Bound to ChooserView's `pick` emit. */
  handleChooserPick: (installation: Installation) => Promise<void>
  /** Bound to ChooserView's `show-new-install` empty-state CTA. */
  handleChooserShowNewInstall: () => void
  /** Picker variant of `performChooserLaunch` without
   *  `prepareChooserHostHandoff`, so the install-backed host isn't
   *  swapped out; launch lands in a fresh window. */
  performPickerLaunch: (installation: Installation) => Promise<ChooserLaunchOutcome>
}

/** Owns the install-less chooser host's launch hand-off, reusing
 *  `useListAction` so it shares the Dashboard's confirm / port-conflict /
 *  telemetry behaviour. `prepareChooserHostHandoff` is exposed separately
 *  for surfaces that route launches straight through `show-progress`. */
export function useChooserHandoff(opts: ChooserHandoffOpts): ChooserHandoffApi {
  const sessionStore = useSessionStore()
  const { executeAction: executeChooserAction } = useListAction('chooser', {
    showProgress: opts.showProgress,
  })

  /** Fallback close-on-launch subscription, set only when the in-place
   *  attach claim is rejected. Cleaned up on unmount to avoid a leak. */
  let pendingPickUnsub: (() => void) | null = null

  /** Prepare the chooser host for an op hand-off. First try to claim the
   *  host for in-place attach, so the install attaches to THIS window
   *  instead of a fresh one. If the claim is rejected, stamp the chooser
   *  host's bounds onto the install so its new window opens here, and (for
   *  launch-class ops) close this host once `instance-started` fires. */
  async function prepareChooserHostHandoff(
    installationId: string,
    triggersInstanceStart = true,
  ): Promise<void> {
    // Drop any prior subscription so a stale one can't close this host on
    // an unrelated `instance-started`.
    pendingPickUnsub?.()
    pendingPickUnsub = null
    const claimed = await window.api.claimAttachHost(installationId)
    if (claimed) return
    // Visual continuity — open the new window at the chooser's position.
    await window.api.transferHostBoundsToInstall(installationId)
    if (!triggersInstanceStart) return
    // Subscribe before launch so we don't miss a fast-firing broadcast.
    pendingPickUnsub = window.api.onInstanceStarted((data) => {
      if (data.installationId !== installationId) return
      pendingPickUnsub?.()
      pendingPickUnsub = null
      void window.api.closeHostWindow()
    })
  }

  /** Shared launch path for chooser-tile clicks and first-use auto-launch.
   *  `onMissingLaunchAction` diverges: tile click → new-install flow;
   *  auto-launch → no-op (the chained install already finished). */
  async function performChooserLaunch(
    installation: Installation,
    onMissingLaunchAction: () => void = () => {},
  ): Promise<ChooserLaunchOutcome> {
    if (sessionStore.isRunning(installation.id)) {
      // Focus the running window and leave the chooser host alive.
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
    // Stake the attach claim only after the guard chain commits to running:
    // staking pre-guard could overwrite a sibling window's claim and attach
    // the install to the wrong window.
    await executeChooserAction(installation, launchAction, {
      onGuardsPassed: () => prepareChooserHostHandoff(installation.id),
    })
    return 'launched'
  }

  async function handleChooserPick(installation: Installation): Promise<void> {
    // On missing launch action, bounce into the new-install flow in this
    // same host rather than a separate window.
    await performChooserLaunch(installation, () => {
      void opts.switchPanel('new-install', 'chooser_pick')
    })
  }

  /** Picker launch path. Like `performChooserLaunch` but skips
   *  `prepareChooserHostHandoff` so the host that opened the picker is
   *  preserved; the install opens in its own window. The already-running
   *  guard is belt-and-braces for the IPC-forward-then-running race. */
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
    // Empty-state CTA — opens new-install as a takeover above the chooser
    // body, so dismissing it returns the user to the chooser.
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
