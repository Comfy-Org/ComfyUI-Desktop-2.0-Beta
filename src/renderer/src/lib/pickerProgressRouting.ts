import type { ShowProgressOpts } from '../types/ipc'

export type ProgressRouting = 'same-host' | 'target-host'

export interface ProgressRoutingDecision {
  /** `'same-host'` keeps the ProgressModal in the picker's parent panel
   *  (today's behaviour). `'target-host'` opens-or-focuses the target
   *  install's window and mounts the ProgressModal there so the user
   *  sees the work happening on the install they actually picked. */
  routing: ProgressRouting
  /** When `true`, ProgressModal renders a terminal choice screen on
   *  success (e.g. `[Go to Dashboard | Open Instance]`) instead of
   *  auto-closing. Reserved for mutating, non-launch, non-destructive
   *  ops where the user might want to *not* open the app immediately
   *  after the action. */
  successChoice: boolean
}

/** Action ids whose entire purpose is to bring up the running app —
 *  the user is going to end up in Comfy regardless, so a terminal
 *  choice screen would just add a click between them and the app.
 *  Updates that *also* trigger an auto-relaunch (`triggersInstanceStart`
 *  side-effect) are NOT in this set: they still need the terminal
 *  screen so the user can pick between "Go to Dashboard" and "Open
 *  Instance" after the work completes. */
const LAUNCH_ACTION_IDS = new Set(['launch', 'restart'])

/** Single source of truth for "where does this picker-initiated progress
 *  op render, and does it end on a choice screen?". Pure function — all
 *  policy lives here, callers just forward the result. New
 *  `showProgress` actions plug in automatically based on their
 *  `actionId` / `destroysInstance` flags. */
export function resolveProgressRouting(
  opts: ShowProgressOpts,
  hostInstallId: string | null,
): ProgressRoutingDecision {
  // Destructive ops (delete and friends) MUST stay in the current host —
  // spawning a window for an install we're about to remove would race
  // the registry teardown and leave a ghost window. They also bypass the
  // success-choice screen (there's nothing to "open").
  if (opts.destroysInstance) {
    return { routing: 'same-host', successChoice: false }
  }

  const routing: ProgressRouting =
    hostInstallId && hostInstallId === opts.installationId ? 'same-host' : 'target-host'

  // Only true launches/restarts skip the terminal state — `triggersInstanceStart`
  // alone isn't enough because Update ops on a running install also set it
  // (auto-relaunch after applying the update) but the user still wants the
  // post-update choice screen.
  const successChoice = !opts.actionId || !LAUNCH_ACTION_IDS.has(opts.actionId)

  return { routing, successChoice }
}
