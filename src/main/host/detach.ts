import { ipcMain } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'
import * as ipc from '../lib/ipc'
import { COMFY_BG } from '../lib/theme'
import { destroyPanelView, ensurePanelView } from './panelView'
import { openSystemModalAsync } from '../popups/systemModal'
import type { SystemModalDetailGroup } from '../popups/systemModal'
import { comfyWindows, isChooserHost, isInstallHost } from './registry'
import type { ComfyWindowEntry } from './registry'
import {
  applyChooserHostTheme,
  CHOOSER_HOST_TITLE_TEXT,
  CHOOSER_HOST_WINDOW_TITLE,
} from './createHostWindow'

/**
 * WeakSet of host windows whose `close` should skip the panel-renderer
 * consult and tear down immediately. The bulk-close confirm dialog
 * already lists in-progress operations / sessions / downloads, so the
 * per-window prompt is redundant noise once the user has confirmed
 * the bulk close. Used by `confirmAndCloseAllHostWindows` (here) and
 * `returnToDashboard` (also here); the close handler in
 * `createHostWindow` reads it via `setHostWindowFactories`.
 */
export const preClearedClose = new WeakSet<BrowserWindow>()

/**
 * Outcome of a panel-renderer close/return consult:
 *   - `cleared`  — proceed (no overlay, or the user confirmed cancelling one)
 *   - `aborted`  — the user backed out of an overlay cancel-prompt; keep open
 *   - `defer`    — no overlay in flight; the *caller* (main) owns the confirm.
 *     The renderer can't be trusted to confirm a close on its own: while an
 *     instance runs, its panel view is hidden behind the ComfyUI view and
 *     may never answer, so the close-window confirm lives in main.
 */
type PanelConsultResult = 'cleared' | 'aborted' | 'defer'

/**
 * Shared wire logic for both panel-renderer consult flows. Sends
 * `{requestPrefix}`, listens for `{requestPrefix}-ack` and
 * `{requestPrefix}-response`. Falls back to `fallback` when the panelView
 * is missing, the webContents is destroyed, the renderer doesn't ack
 * within 2s, or the webContents goes away mid-flight.
 *
 * Once the renderer acks receipt we wait INDEFINITELY for the actual
 * response — the user may be staring at a confirm modal, and a fixed
 * timeout would force-close out from under their prompt.
 */
async function consultPanelRenderer(
  panelView: WebContentsView | null | undefined,
  requestPrefix:
    | 'comfy-window:request-close'
    | 'comfy-window:request-return-to-dashboard',
  fallback: PanelConsultResult,
): Promise<PanelConsultResult> {
  if (!panelView || panelView.webContents.isDestroyed()) return fallback
  return new Promise<PanelConsultResult>((resolve) => {
    const prefix = requestPrefix === 'comfy-window:request-close' ? 'close' : 'rtd'
    const requestId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const ackChannel = `${requestPrefix}-ack`
    const responseChannel = `${requestPrefix}-response`
    let settled = false
    let acked = false
    const cleanup = (): void => {
      ipcMain.off(ackChannel, onAck)
      ipcMain.off(responseChannel, onResponse)
      if (!panelView.webContents.isDestroyed()) {
        panelView.webContents.off('render-process-gone', onCrash)
        panelView.webContents.off('destroyed', onCrash)
      }
    }
    const onAck = (
      event: Electron.IpcMainEvent,
      payload: { requestId?: string } | undefined,
    ): void => {
      if (event.sender !== panelView.webContents) return
      if (payload?.requestId !== requestId) return
      acked = true
    }
    const onResponse = (
      event: Electron.IpcMainEvent,
      payload: { requestId?: string; cleared?: boolean; defer?: boolean } | undefined,
    ): void => {
      if (event.sender !== panelView.webContents) return
      if (payload?.requestId !== requestId) return
      if (settled) return
      settled = true
      cleanup()
      resolve(payload?.defer ? 'defer' : payload?.cleared ? 'cleared' : 'aborted')
    }
    const onCrash = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(fallback)
    }
    ipcMain.on(ackChannel, onAck)
    ipcMain.on(responseChannel, onResponse)
    panelView.webContents.on('render-process-gone', onCrash)
    panelView.webContents.on('destroyed', onCrash)
    try {
      panelView.webContents.send(requestPrefix, { requestId })
    } catch {
      settled = true
      cleanup()
      resolve(fallback)
      return
    }
    setTimeout(() => {
      if (settled || acked) return
      settled = true
      cleanup()
      resolve(fallback)
    }, 2000)
  })
}

/**
 * Main consults the panel renderer before tearing down a host
 * window so a Tier 2 progress / Tier 3 takeover overlay can prompt
 * the user to confirm cancellation. Returns:
 *   - `cleared`  — no overlay, or the user confirmed cancelling one
 *   - `aborted`  — the user dismissed the cancel-prompt; keep open
 *   - `defer`    — no overlay; the close-window confirm is main's job
 * Falls back to `defer` if the renderer can't be reached (hidden behind
 * a running ComfyUI view, crashed, or slow to ack) so the confirm still
 * fires from main rather than being silently skipped.
 */
export async function consultPanelRendererClose(
  panelView: WebContentsView | null | undefined,
): Promise<PanelConsultResult> {
  return consultPanelRenderer(panelView, 'comfy-window:request-close', 'defer')
}

/**
 * Main consults the panel renderer before flipping an install-backed
 * host window back to the dashboard (File menu's Return to Dashboard).
 * Layers two prompts on the renderer side:
 *   - Tier 2/3 overlay in flight → standard cancel-prompt copy.
 *   - No overlay + local install → "Stop ComfyUI?" confirm so the
 *     user knows the running session is about to be torn down.
 * Cloud / remote installs (and chooser hosts) clear immediately.
 */
export async function consultPanelRendererReturnToDashboard(
  panelView: WebContentsView | null | undefined,
): Promise<boolean> {
  // Return-to-dashboard has no `defer` path — the renderer owns its prompt
  // (and a missing renderer clears). Map the tri-state onto the boolean
  // contract this caller expects.
  return (
    (await consultPanelRenderer(panelView, 'comfy-window:request-return-to-dashboard', 'cleared')) ===
    'cleared'
  )
}

/**
 * Close every host window (install-backed and chooser hosts alike) but
 * leave the app / tray alive. Bound to the File menu's "Close All
 * Windows" entry. Each window's existing `close` handler runs the
 * full teardown (`stopRunning` + webContents close + window.destroy),
 * so we just dispatch `close()` and let those handlers do the work
 * — the handlers also consult the panel renderer unless the window
 * is already in `preClearedClose`. Snapshot the entry list
 * first so the iteration isn't affected by `closed` callbacks that
 * delete from the `comfyWindows` map mid-loop.
 */
export function closeAllHostWindows(): void {
  const entries = Array.from(comfyWindows.values())
  for (const entry of entries) {
    if (!entry.window.isDestroyed()) entry.window.close()
  }
}

/**
 * File menu's "Return to Dashboard" entry. Flips the install-backed
 * host window in place to chooser mode via `entry.detachInstall()` —
 * same BrowserWindow, same bounds, same window-key; the install
 * binding is torn down (listeners off, comfyView navigated to
 * about:blank, panelView remounted in chooser mode) and the title
 * bar repaints to the chooser-host identity.
 *
 * Funnels through `consultPanelRendererReturnToDashboard` so the
 * renderer can layer the in-flight cancel-prompt (Tier 2/3 overlays)
 * AND the local-install "Stop ComfyUI?" confirm on top of one another;
 * cloud / remote installs clear silently.
 */
export async function returnToDashboard(parentEntryId: number): Promise<void> {
  const entry = comfyWindows.get(parentEntryId)
  if (!entry || isChooserHost(entry) || entry.window.isDestroyed()) return
  const cleared = await consultPanelRendererReturnToDashboard(entry.panelView)
  if (!cleared) return
  if (entry.window.isDestroyed()) return
  entry.detachInstall()
}

/**
 * Confirm a `closeAllHostWindows()` dispatch when more than one host
 * window is open. The dialog lists the open windows by title (so the
 * user can see what's about to close) and any active operations that
 * will be cancelled — running ComfyUI sessions, in-progress
 * installs / updates, active model downloads — pulled from the same
 * `getActiveDetails()` helper. With one or zero windows the close
 * happens straight through with no prompt.
 */
export async function confirmAndCloseAllHostWindows(
  parentWindow: BrowserWindow | null,
  performQuit: () => void,
): Promise<void> {
  const entries = Array.from(comfyWindows.values()).filter((e) => !e.window.isDestroyed())
  // "Instances" = install-backed host windows. The dashboard (chooser
  // host) is never listed and never blocks the quit — quitting from the
  // dashboard with nothing else running should just exit.
  const instanceWindows = entries.filter((e) => isInstallHost(e))
  if (instanceWindows.length === 0) {
    performQuit()
    return
  }
  // One clean line per open instance — the title-bar pill name, not the
  // verbose OS window title ("… — *Unsaved Workflow — Desktop 2.0 v…").
  const titles = instanceWindows.map((e) => e.titleBarText || 'Untitled instance')
  const details: SystemModalDetailGroup[] = [
    { label: 'Open instances', items: titles },
  ]
  // Surface the *extra* things a full quit tears down — in-progress
  // operations and active downloads. Running ComfyUI sessions are
  // deliberately NOT re-listed: a running instance already appears in
  // "Open instances", and listing it twice made one instance look like
  // two.
  if (ipc.hasActiveOperations()) {
    try {
      const items = await ipc.getActiveDetails()
      const operations = items.filter((i) => i.type === 'operation').map((i) => i.name)
      const downloads = items.filter((i) => i.type === 'download').map((i) => i.name)
      if (operations.length > 0) details.push({ label: 'In-progress operations', items: operations })
      if (downloads.length > 0) details.push({ label: 'Active downloads', items: downloads })
    } catch {
      // If active-detail collection ever throws, fall back to just the
      // instance list — the user still sees what's about to close.
    }
  }
  // Pick the parent for the overlay. Prefer the caller's hint (the
  // window the user clicked Quit from); fall back to any live host so we
  // don't drop the confirm entirely when the popup's parent has gone
  // away mid-flight.
  const overlayParentEntry = parentWindow && !parentWindow.isDestroyed()
    ? entries.find((e) => e.window === parentWindow)
    : entries[0]
  if (!overlayParentEntry) {
    performQuit()
    return
  }
  const count = instanceWindows.length
  const confirmed = await openSystemModalAsync({
    parent: overlayParentEntry.window,
    spec: {
      title: 'Quit ComfyUI',
      message: count === 1
        ? 'Quit ComfyUI? This will close the running instance.'
        : `Quit ComfyUI? This will close ${count} running instances.`,
      details,
      confirmLabel: 'Quit',
      cancelLabel: 'Cancel',
      confirmStyle: 'danger',
      theme: overlayParentEntry.lastTheme,
    },
  })
  if (confirmed) performQuit()
}

/**
 * The shared "Close Window" confirm. Used by BOTH the instance menu's
 * Close Window entry and the OS ✕ handler (for an idle instance) so the
 * two paths show the identical shell-level modal. It lives in main rather
 * than the panel renderer because the renderer is hidden behind the
 * ComfyUI view while an instance runs and can't be relied on to surface a
 * prompt — the native ✕ was closing silently for exactly that reason.
 */
export async function confirmCloseInstanceWindow(
  window: BrowserWindow,
  isLastWindow: boolean,
  theme: { bg: string; text: string },
): Promise<boolean> {
  return openSystemModalAsync({
    parent: window,
    spec: {
      title: 'Close Window',
      message: isLastWindow
        ? 'Close this window? This stops ComfyUI and returns you to the dashboard.'
        : 'Close this window? This stops the running ComfyUI instance.',
      confirmLabel: isLastWindow ? 'Close & Return to Dashboard' : 'Close Window',
      cancelLabel: 'Cancel',
      confirmStyle: 'danger',
      theme,
    },
  })
}

/**
 * Confirm + close a single install-backed host window. Bound to the
 * instance menu's `Close Window` entry. Closing always confirms, because
 * it *stops* the running ComfyUI instance (not just hides the window).
 * Model downloads are owned by the desktop app, not the instance, so
 * they keep running after a close — hence no active-download list here
 * (that warning belongs to `Quit ComfyUI`).
 *
 * If this is the only live host window, closing it would quit the app,
 * so instead we stop the instance and flip the window in place to the
 * dashboard (`detachInstall`). With other windows open, we close this
 * one outright; its `close` handler runs the per-window teardown.
 */
export async function confirmAndCloseHostWindow(parentWindow: BrowserWindow): Promise<void> {
  if (parentWindow.isDestroyed()) return
  const entry = Array.from(comfyWindows.values()).find((e) => e.window === parentWindow)
  if (!entry) {
    parentWindow.close()
    return
  }
  const liveWindowCount = Array.from(comfyWindows.values()).filter(
    (e) => !e.window.isDestroyed(),
  ).length
  const isLastWindow = liveWindowCount <= 1
  const confirmed = await confirmCloseInstanceWindow(entry.window, isLastWindow, entry.lastTheme)
  if (!confirmed) return
  if (isLastWindow) {
    // Stop the instance and flip this window to the dashboard rather than
    // closing it (closing the last window would quit the app).
    entry.detachInstall()
  } else {
    // Skip the panel-renderer consult on the close handler — the user
    // already confirmed via this prompt.
    preClearedClose.add(entry.window)
    entry.window.close()
  }
}

/**
 * Flip an install-backed host window in place to install-less
 * (chooser) mode. The symmetric undo to `attachInstall()`. Bound
 * onto `entry.detachInstall` by `createHostWindow()`; the
 * underscore-prefixed name signals that callers should invoke
 * `entry.detachInstall()` rather than this freestanding helper
 * directly.
 *
 * Steps:
 *   1. Runs `entry._installCleanup()` — `attachInstall()`'s stashed
 *      undo: off all install-bound comfyContents listeners, cancel
 *      the fail-retry timer, ipc.stopRunning the running session,
 *      clear the install-keyed maps + the secondary index, and reset
 *      `entry.installationId` / `entry.comfyUrl`.
 *   2. Navigates the comfyView to `about:blank` so the loaded
 *      ComfyUI page is unloaded (releases its renderer process). The
 *      comfyView is kept alive (not destroyed) so the host can be
 *      re-attached later without rebuilding.
 *   3. Resets the title-bar identity (`titleBarText` →
 *      `'Desktop 2.0 Beta'`, `sourceCategory` → `null`) and pushes
 *      to the live title-bar.
 *   4. Resets the OS-level window title.
 *   5. Re-paints the title bar to the launcher-theme surface
 *      (chooser hosts derive their theme from the launcher setting,
 *      not from a ComfyUI frontend).
 *   6. Resets `entry.activePanel` to `'comfy'` (which now resolves
 *      to the chooser body via `computeBodyMode`) and ensures a
 *      panelView with the chooser body exists.
 *   7. Calls `entry.layoutViews()` so the chooser body becomes
 *      visible immediately.
 *
 * No-op when the entry is already install-less (no install backing
 * to detach). Does not destroy the comfyView or the BrowserWindow
 * — see the close handler in `createHostWindow()` for the destroy
 * path.
 */
export function _detachInstallImpl(entry: ComfyWindowEntry): void {
  if (isChooserHost(entry)) return
  if (entry.window.isDestroyed()) return

  // Symmetric undo of attachInstall (listeners, maps, stopRunning, etc).
  entry._installCleanup?.()

  // Release the ComfyUI page; the view is kept alive for re-attach.
  if (!entry.comfyView.webContents.isDestroyed()) {
    void entry.comfyView.webContents.loadURL('about:blank').catch(() => {})
    entry.comfyView.setBackgroundColor(COMFY_BG)
  }

  // Flip entry identity back to chooser-host shape, then push every
  // identity-derived signal to the title-bar renderer. The title bar
  // is a long-lived view that doesn't reload across attach / detach
  // (cf. the install-id push at `attachInstall`); we push title /
  // source-category / installation-id / install-update / preview-mode
  // here explicitly so the renderer sees the chooser identity
  // without relying on a fresh title-bar-ready handshake.
  entry.titleBarText = CHOOSER_HOST_TITLE_TEXT
  entry.sourceCategory = null
  entry.previewInstallationId = null
  entry.activePanel = 'comfy'
  entry.window.setTitle(CHOOSER_HOST_WINDOW_TITLE)
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
    entry.titleBarView.webContents.send('comfy-titlebar:installation-id-changed', null)
    entry.titleBarView.webContents.send('comfy-titlebar:preview-mode-changed', false)
    // Install-update pill state is install-scoped; reset to the
    // "no update" shape on the way back to chooser identity so the
    // pill clears immediately instead of inheriting the prior
    // install's pending-update flag until a re-attach happens.
    entry.titleBarView.webContents.send('comfy-titlebar:install-update-changed', {
      available: false,
      version: null,
    })
  }
  applyChooserHostTheme(entry)

  // Tear down the install-backed PanelApp and remount fresh in chooser mode.
  // Preserves no per-install state (overlays, activePanel, installationId
  // URL param) across the detach.
  destroyPanelView(entry)
  ensurePanelView(entry.windowKey, entry, 'chooser')
  entry.layoutViews()
}

/**
 * Detach every install-backed host window whose backing install is no
 * longer in the provided live-id set. Covers the delete-action and
 * untrack-action paths (both emit `installationEvents.changed`); without
 * this, an install-backed host would keep rendering chrome / IPC wiring
 * for a non-existent install.
 *
 * Snapshots the entry list up front so a synchronous detach callback
 * that mutates `comfyWindows` doesn't skip later entries.
 */
export function detachOrphanedInstallHosts(liveIds: ReadonlySet<string>): void {
  const entries = Array.from(comfyWindows.values())
  for (const entry of entries) {
    if (entry.window.isDestroyed()) continue
    if (!isInstallHost(entry)) continue
    if (!entry.installationId) continue
    if (liveIds.has(entry.installationId)) continue
    entry.detachInstall()
  }
}
