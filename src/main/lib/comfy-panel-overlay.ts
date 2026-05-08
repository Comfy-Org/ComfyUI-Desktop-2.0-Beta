/**
 * Title-bar → panel-renderer IPC dispatch helpers.
 *
 * Every title-bar IPC handler that needs to push a popover, modal, or
 * other panel-renderer-driven UI onto a Comfy host window MUST funnel
 * the send through one of these helpers. The reasons:
 *
 *   1. Lazy panelView. On Comfy instance windows the `panelView`
 *      WebContentsView is constructed lazily — only on the first
 *      non-comfy switch (Settings / Directories / lifecycle). A
 *      title-bar click that arrives while the user is still on the
 *      live ComfyUI body would hit a `null` panelView and silently
 *      drop. Callers must hand this helper an *existing* panelView
 *      (use the `getOrCreatePanelView()` helper in `index.ts` to
 *      lazy-create one when needed).
 *
 *   2. did-finish-load race. Even when the panelView exists, its
 *      Vue bundle may still be loading. A synchronous
 *      `webContents.send()` would land before the renderer's
 *      `onPanelTriggerOverlay(...)` / `onOpenFeedback(...)`
 *      subscription was wired in `onMounted`. The helper guards this
 *      by deferring the dispatch to `did-finish-load` whenever
 *      `isLoadingMainFrame()` is true.
 *
 *   3. destroyed-window safety. The helper bails on every
 *      `webContents.isDestroyed()` edge so a window-close racing the
 *      IPC can't crash main.
 *
 * The channel literals are private to this module on purpose — every
 * other reference to them is enforced absent by
 * `title-bar-overlay-guard.test.ts`. New title-bar→panel IPCs should
 * either reuse one of the existing helpers (preferred) or add a new
 * helper here, NOT inline a fresh `webContents.send(literal, …)`
 * elsewhere.
 *
 * The pattern was first applied to the title-bar Send Feedback button
 * (PR #508 / `0a063bc`) when its lazy-panelView regression on Comfy
 * windows was fixed; #523 surfaced the same regression on the
 * downloads tray and the Desktop Update pill, which is why all three
 * call sites now route through here.
 */
import type { WebContentsView } from 'electron'

const PANEL_TRIGGER_OVERLAY_CHANNEL = 'panel-trigger-overlay'
const OPEN_FEEDBACK_CHANNEL = 'comfy-panel:open-feedback'

/**
 * Mirrors the `onPanelTriggerOverlay` payload union in
 * `src/types/ipc.ts`. Kept narrow on purpose so adding a new kind
 * shows up at every call site as a TS error.
 */
export type PanelOverlayPayload =
  | { kind: 'install-update'; installationId: string }
  | { kind: 'downloads' }
  | { kind: 'app-update-restart-prompt'; version: string | null }
  | { kind: 'app-update-download-prompt'; version: string | null }

function dispatchWhenReady(
  panelView: WebContentsView,
  channel: string,
  payload: unknown,
): void {
  const wc = panelView.webContents
  if (wc.isDestroyed()) return
  const send = (): void => {
    if (wc.isDestroyed()) return
    wc.send(channel, payload)
  }
  if (wc.isLoadingMainFrame()) {
    wc.once('did-finish-load', send)
  } else {
    send()
  }
}

/** Push a `panel-trigger-overlay` to the panel renderer (downloads
 *  popover, app-update modal, install-update deep-link). See the
 *  module docstring for the invariants every call site relies on. */
export function triggerPanelOverlay(
  panelView: WebContentsView,
  payload: PanelOverlayPayload,
): void {
  dispatchWhenReady(panelView, PANEL_TRIGGER_OVERLAY_CHANNEL, payload)
}

/** Push a Send Feedback request to the panel renderer (the renderer
 *  fires the `desktop2.feedback.opened` telemetry action and opens
 *  the support URL via `openExternal`). */
export function triggerOpenFeedback(
  panelView: WebContentsView,
  source: 'titlebar' | 'menu',
): void {
  dispatchWhenReady(panelView, OPEN_FEEDBACK_CHANNEL, { source })
}
