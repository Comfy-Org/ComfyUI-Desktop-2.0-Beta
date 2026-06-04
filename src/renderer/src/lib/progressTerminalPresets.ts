/** Terminal state rendered by ProgressModal on success when the caller opts in. */
export interface SuccessTerminal {
  /** Optional headline; ProgressModal falls back to "{op title} complete" when omitted. */
  title?: string
  actions: SuccessTerminalAction[]
}

export interface SuccessTerminalAction {
  id: string
  label: string
  variant: 'primary' | 'ghost'
}

// Stable ids the panel-side overlay handler switches on; exported so renames flow through type-checking.
export const SUCCESS_ACTION_GO_DASHBOARD = 'go-dashboard'
export const SUCCESS_ACTION_OPEN_INSTANCE = 'open-instance'

/** Picker-flow preset: on success, offer return-to-dashboard or open-the-instance. */
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
