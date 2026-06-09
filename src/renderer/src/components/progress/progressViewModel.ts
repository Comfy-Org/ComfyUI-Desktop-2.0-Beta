/**
 * Normalized view-model for the swappable launch/op progress presentation.
 *
 * The container (`ProgressModal.vue`) owns all behaviour and derives this
 * read-only shape from the progress store; presentational views
 * (`BrandProgressView`, `MinimalProgressView`, …) render it and emit intent
 * events only. Because every view reads the SAME model, swapping one for
 * another (the `variant` prop on `ProgressViewHost`) is guaranteed to change
 * pixels only, never behaviour — the CTO-demo seam.
 */

/** One phase row in the two-level display. */
export interface ProgressStepVM {
  phase: string
  /** Human label for the phase (already i18n-resolved). */
  label: string
  /** `done` → checkmark; `active` → spinner/bar + live detail; `pending` → dimmed. */
  status: 'done' | 'active' | 'pending'
  /** Live sub-activity for the active row — "4 of 7", VRAM, or the latest
   *  streaming log line. Null when there's nothing extra to show. */
  detail: string | null
  /** Determinate fill for the active row's mini-bar, or null for a spinner
   *  (unbounded phase). */
  subPercent: number | null
}

export interface ProgressViewModel {
  /** Overall 0→100 bar. */
  percent: number
  indeterminate: boolean
  /** Headline caption for the active phase. */
  caption: string
  /** The two-level phase rows. Empty for flat (non-stepped) ops. */
  steps: ProgressStepVM[]
}
