import type { ShowProgressOpts } from '../types/ipc'

export type ProgressRouting = 'same-host' | 'target-host' | 'inline-picker'

export interface ProgressRoutingDecision {
  /** `'same-host'` keeps the ProgressModal in the picker's parent panel.
   *  `'target-host'` opens-or-focuses the target install's window (used
   *  for launch/restart which intentionally navigate the user there).
   *  `'inline-picker'` keeps the picker open and streams progress in the
   *  right pane — used for cross-instance mutating ops so the user's
   *  current window is never disrupted. */
  routing: ProgressRouting
  /** When `true`, a success state is shown with an `[Open Instance]` CTA.
   *  For same-host this is the ProgressModal terminal screen; for
   *  inline-picker it's the right pane's success state. */
  successChoice: boolean
}

/** Action ids whose purpose is to bring the user into the running app —
 *  routing them to the target window is intentional navigation.
 *  Updates that also trigger an auto-relaunch (`triggersInstanceStart`
 *  side-effect) are NOT in this set: the user still gets a choice screen. */
const LAUNCH_ACTION_IDS = new Set(['launch', 'restart'])

/** Single source of truth for "where does this picker-initiated progress
 *  op render, and does it end on a choice screen?". Pure function — all
 *  policy lives here, callers just forward the result. */
export function resolveProgressRouting(
  opts: ShowProgressOpts,
  _hostInstallId: string | null,
): ProgressRoutingDecision {
  // Destructive ops stay in the current host — routing to a window we're
  // about to tear down would race the registry teardown and leave a ghost.
  if (opts.destroysInstance) {
    return { routing: 'same-host', successChoice: false }
  }

  // Launch/Restart: intentional navigation to the target window.
  if (opts.actionId && LAUNCH_ACTION_IDS.has(opts.actionId)) {
    return { routing: 'target-host', successChoice: false }
  }

  // All mutating ops (same-instance or cross-instance) use inline picker progress.
  // The picker stays open; the right pane shows progress/success/error inline.
  return { routing: 'inline-picker', successChoice: true }
}
