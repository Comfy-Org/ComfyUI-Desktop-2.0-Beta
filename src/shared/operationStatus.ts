/**
 * Cross-process strings used by background-op status reporting.
 *
 * `MSG_CANCELLED` is the single user-cancel string written by both the
 * session-action wrapper (`withAbortableSessionAction`) and the picker's
 * outer-catch mapper in `src/main/index.ts`, and matched verbatim by
 * the renderer's inline progress card (`PickerInlineProgress.vue`) to
 * render the cancelled banner. Keep all writers and matchers using
 * this constant — drift between sites (e.g. `'Cancelled'` vs
 * `'Cancelled.'`) silently breaks the cancel UI.
 */
export const MSG_CANCELLED = 'Cancelled.'
