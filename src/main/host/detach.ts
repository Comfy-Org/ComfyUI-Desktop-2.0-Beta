import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'
import * as ipc from '../lib/ipc'
import { COMFY_BG } from '../lib/theme'
import { destroyPanelView, ensurePanelView } from './panelView'
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
 * Shared wire logic for both panel-renderer consult flows. Sends
 * `{requestPrefix}`, listens for `{requestPrefix}-ack` and
 * `{requestPrefix}-response`. Returns `cleared`. Falls back to
 * "cleared" when the panelView is missing, the webContents is
 * destroyed, the renderer doesn't ack within 2s, or the
 * webContents goes away mid-flight.
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
): Promise<boolean> {
  if (!panelView || panelView.webContents.isDestroyed()) return true
  return new Promise<boolean>((resolve) => {
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
      payload: { requestId?: string; cleared?: boolean } | undefined,
    ): void => {
      if (event.sender !== panelView.webContents) return
      if (payload?.requestId !== requestId) return
      if (settled) return
      settled = true
      cleanup()
      resolve(!!payload?.cleared)
    }
    const onCrash = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(true)
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
      resolve(true)
      return
    }
    setTimeout(() => {
      if (settled || acked) return
      settled = true
      cleanup()
      resolve(true)
    }, 2000)
  })
}

/**
 * Main consults the panel renderer before tearing down a host
 * window so a Tier 2 progress / Tier 3 takeover overlay can
 * prompt the user to confirm cancellation via the standardised
 * cancel-prompt copy. Returns true when the renderer cleared the
 * close (no overlay open, or the user confirmed cancellation),
 * false when the renderer aborted (user dismissed the prompt).
 */
export async function consultPanelRendererClose(
  panelView: WebContentsView | null | undefined,
): Promise<boolean> {
  return consultPanelRenderer(panelView, 'comfy-window:request-close')
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
  return consultPanelRenderer(panelView, 'comfy-window:request-return-to-dashboard')
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
): Promise<void> {
  const entries = Array.from(comfyWindows.values()).filter((e) => !e.window.isDestroyed())
  if (entries.length <= 1) {
    closeAllHostWindows()
    return
  }
  const titles = entries.map((e) => e.window.getTitle() || 'Untitled window')
  const detailLines: string[] = ['Open windows:', ...titles.map((t) => `  • ${t}`)]
  if (ipc.hasActiveOperations()) {
    try {
      const items = await ipc.getActiveDetails()
      const sessions = items.filter((i) => i.type === 'session').map((i) => i.name)
      const operations = items.filter((i) => i.type === 'operation').map((i) => i.name)
      const downloads = items.filter((i) => i.type === 'download').map((i) => i.name)
      if (sessions.length > 0) {
        detailLines.push('', 'Running ComfyUI:', ...sessions.map((n) => `  • ${n}`))
      }
      if (operations.length > 0) {
        detailLines.push('', 'In-progress operations:', ...operations.map((n) => `  • ${n}`))
      }
      if (downloads.length > 0) {
        detailLines.push('', 'Active downloads:', ...downloads.map((n) => `  • ${n}`))
      }
    } catch {
      // If active-detail collection ever throws, fall back to just the
      // window list — the user still sees what's about to close.
    }
  }
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Close All', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Close All Windows',
    message: `Close ${entries.length} open windows?`,
    detail: detailLines.join('\n'),
  }
  const result = parentWindow && !parentWindow.isDestroyed()
    ? await dialog.showMessageBox(parentWindow, opts)
    : await dialog.showMessageBox(opts)
  if (result.response === 0) {
    // The global dialog already lists in-progress ops / sessions /
    // downloads, so the per-window tier-aware prompt would be
    // redundant after the user confirmed the bulk close. Pre-clear
    // every entry so each window's `close` handler skips its own
    // consult and tears down immediately.
    for (const entry of entries) preClearedClose.add(entry.window)
    closeAllHostWindows()
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
