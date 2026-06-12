/**
 * One phase row in the launch/op progress stepper. `ProgressModal.vue` derives
 * these from the progress store and passes them to `BrandProgressView`, which
 * holds no logic of its own.
 */
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
  /** Non-fatal failure on the active row — renders the detail line in an error
   *  style (red/bold + X) without failing the op. Only ever true for `active`. */
  isError: boolean
}
