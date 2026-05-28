/** Terminal state rendered by ProgressModal on success when the caller
 *  opts in (mutating, non-launch ops where the user might NOT want to
 *  open the app right away). Generic shape — new flows mint a new
 *  factory below; ProgressModal itself stays untouched. */
export interface SuccessTerminal {
  /** Optional headline. ProgressModal falls back to "{op title} complete"
   *  when omitted. */
  title?: string
  actions: SuccessTerminalAction[]
}

export interface SuccessTerminalAction {
  id: string
  label: string
  variant: 'primary' | 'ghost'
}

/** Stable ids for the picker's "what next?" choice. Consumers
 *  (panel-side overlay handler) switch on these to wire the actual
 *  behaviour — `openInstallWindow` for `open-instance`,
 *  `return-to-dashboard` activation for `go-dashboard`. Exported as
 *  constants so renames flow through type-checking. */
export const SUCCESS_ACTION_GO_DASHBOARD = 'go-dashboard'
export const SUCCESS_ACTION_OPEN_INSTANCE = 'open-instance'

/** Picker-flow preset: after a mutating non-launch op finishes
 *  successfully, ask the user whether they want to return to the
 *  dashboard or open the just-touched instance. Order is intentional —
 *  "Open Instance" is the primary CTA on the right (matches the picker
 *  footer's primary-action placement). */
export function successTerminalGoDashboardOrOpen(opts: {
  title?: string
  dashboardLabel: string
  openLabel: string
}): SuccessTerminal {
  return {
    ...(opts.title === undefined ? {} : { title: opts.title }),
    actions: [
      { id: SUCCESS_ACTION_GO_DASHBOARD, label: opts.dashboardLabel, variant: 'ghost' },
      { id: SUCCESS_ACTION_OPEN_INSTANCE, label: opts.openLabel, variant: 'primary' },
    ],
  }
}
