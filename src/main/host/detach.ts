import { ipcMain } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'
import * as ipc from '../lib/ipc'
import { _runningSessions } from '../lib/ipc/shared'
import { COMFY_BG } from '../lib/theme'
import { destroyPanelView, ensurePanelView } from './panelView'
import { openSystemModalAsync, openSystemModalChoiceAsync } from '../popups/systemModal'
import type { SystemModalDetailGroup } from '../popups/systemModal'
import { recordDashboardSurface } from '../lib/lastSession'
import { comfyWindows, isChooserHost, isInstallHost, shouldConfirmKillForEntry } from './registry'
import type { ComfyWindowEntry } from './registry'
import {
  applyChooserHostTheme,
  CHOOSER_HOST_TITLE_TEXT,
  CHOOSER_HOST_WINDOW_TITLE,
} from './createHostWindow'
import type { CloseWindowChoice } from './createHostWindow'

/**
 * Host windows whose `close` should skip the panel-renderer consult and tear down
 * immediately, because the bulk-close confirm already listed everything at risk.
 */
export const preClearedClose = new WeakSet<BrowserWindow>()

/**
 * Outcome of a panel-renderer close/return consult:
 *   - `cleared`  — proceed (no overlay, or the user confirmed cancelling one)
 *   - `aborted`  — the user backed out of an overlay cancel-prompt; keep open
 *   - `defer`    — no overlay in flight; main owns the confirm (the renderer can't be
 *     trusted: while an instance runs its panel view is hidden behind ComfyUI).
 */
type PanelConsultResult = 'cleared' | 'aborted' | 'defer'

/**
 * Shared wire logic for both panel-renderer consult flows. Falls back to `fallback` when
 * the panelView is missing/destroyed, the renderer doesn't ack within 2s, or the
 * webContents goes away mid-flight. After the ack we wait INDEFINITELY for the response:
 * the user may be staring at a confirm modal, and a timeout would force-close out from
 * under their prompt.
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
 * Consult the panel renderer before tearing down a host window so an in-flight overlay can
 * prompt to confirm cancellation. Falls back to `defer` when the renderer can't be reached
 * so the confirm still fires from main.
 */
export async function consultPanelRendererClose(
  panelView: WebContentsView | null | undefined,
): Promise<PanelConsultResult> {
  return consultPanelRenderer(panelView, 'comfy-window:request-close', 'defer')
}

/**
 * Consult the panel renderer before flipping an install-backed host window back to the
 * dashboard. Cloud / remote installs and chooser hosts clear immediately.
 */
export async function consultPanelRendererReturnToDashboard(
  panelView: WebContentsView | null | undefined,
): Promise<boolean> {
  // No `defer` path here (the renderer owns its prompt, a missing renderer clears); map
  // the tri-state onto this caller's boolean contract.
  return (
    (await consultPanelRenderer(panelView, 'comfy-window:request-return-to-dashboard', 'cleared')) ===
    'cleared'
  )
}

/**
 * Close every host window but leave the app / tray alive. Each window's own `close` handler
 * runs the full teardown. Snapshot the entry list first so `closed` callbacks that delete
 * from `comfyWindows` mid-loop don't skip entries.
 */
export function closeAllHostWindows(): void {
  const entries = Array.from(comfyWindows.values())
  for (const entry of entries) {
    if (!entry.window.isDestroyed()) entry.window.close()
  }
}

/**
 * File menu's "Return to Dashboard" entry. Flips the install-backed host window in place to
 * chooser mode via `entry.detachInstall()`. Confirm surface depends on panelView state:
 * alive → renderer consult; destroyed → a shell system modal. Cloud / remote installs and
 * stopped sessions clear silently.
 */
export async function returnToDashboard(parentEntryId: number): Promise<void> {
  const entry = comfyWindows.get(parentEntryId)
  if (!entry || isChooserHost(entry) || entry.window.isDestroyed()) return
  const panelAlive = !!entry.panelView && !entry.panelView.webContents.isDestroyed()
  const cleared = panelAlive
    ? await consultPanelRendererReturnToDashboard(entry.panelView)
    : await confirmReturnToDashboardViaSystemModal(entry)
  if (!cleared) return
  if (entry.window.isDestroyed()) return
  entry.detachInstall()
}

/**
 * "Return to Dashboard" confirm as a shell system modal, used when the panelView is
 * destroyed. Mirrors `useReturnToDashboardConfirm`: skips the prompt for non-local installs
 * and already-stopped sessions.
 */
async function confirmReturnToDashboardViaSystemModal(
  entry: ComfyWindowEntry,
): Promise<boolean> {
  if (entry.sourceCategory !== 'local') return true
  if (entry.installationId === null) return true
  if (!_runningSessions.has(entry.installationId)) return true
  if (entry.window.isDestroyed()) return true
  return openSystemModalAsync({
    parent: entry.window,
    spec: {
      title: 'Return to Dashboard?',
      message: 'This will stop the current ComfyUI.',
      confirmLabel: 'Return to Dashboard',
      cancelLabel: 'Cancel',
      confirmStyle: 'danger',
      theme: entry.lastTheme,
    },
  })
}

/**
 * Confirm a quit when more than one instance window is open, listing the open windows and
 * any active operations / downloads that will be cancelled. With one or zero, quit straight
 * through.
 */
export async function confirmAndCloseAllHostWindows(
  parentWindow: BrowserWindow | null,
  performQuit: () => void,
): Promise<void> {
  const entries = Array.from(comfyWindows.values()).filter((e) => !e.window.isDestroyed())
  // "Instances" = windows that would lose a local ComfyUI process on quit. Chooser hosts
  // and cloud/remote windows close silently (no local work at risk).
  const instanceWindows = entries.filter((e) => shouldConfirmKillForEntry(e))
  if (instanceWindows.length === 0) {
    performQuit()
    return
  }
  // Use the title-bar pill name, not the verbose OS window title.
  const titles = instanceWindows.map((e) => e.titleBarText || 'Untitled instance')
  const details: SystemModalDetailGroup[] = [
    { label: 'Open instances', items: titles },
  ]
  // Surface the EXTRA things a quit tears down. Running sessions are deliberately NOT
  // re-listed: they already appear under "Open instances".
  if (ipc.hasActiveOperations()) {
    try {
      const items = await ipc.getActiveDetails()
      const operations = items.filter((i) => i.type === 'operation').map((i) => i.name)
      const downloads = items.filter((i) => i.type === 'download').map((i) => i.name)
      if (operations.length > 0) details.push({ label: 'In-progress operations', items: operations })
      if (downloads.length > 0) details.push({ label: 'Active downloads', items: downloads })
    } catch {
      // Fall back to just the instance list if active-detail collection throws.
    }
  }
  // Prefer the caller's hint, falling back to any live host so the confirm isn't dropped
  // when the popup's parent goes away mid-flight.
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
      title: 'Quit Desktop',
      message: count === 1
        ? 'Quit Desktop? This will close the running ComfyUI instance.'
        : `Quit Desktop? This will close ${count} running ComfyUI instances.`,
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
 * Shared "Close Window" confirm, used by both the menu entry and the OS ✕ handler. Lives in
 * main, not the panel renderer, because the renderer is hidden behind ComfyUI while an
 * instance runs and can't be relied on to surface a prompt.
 *
 * The last window adds a "Return to Dashboard" middle option so closing it isn't a forced
 * quit — the primary action quits Desktop, the secondary keeps the app on the dashboard.
 * `stopsLocalComfy` tailors the copy (a stopped / cloud window has no local process to stop).
 */
export async function confirmCloseInstanceWindow(
  window: BrowserWindow,
  isLastWindow: boolean,
  stopsLocalComfy: boolean,
  theme: { bg: string; text: string },
): Promise<CloseWindowChoice> {
  if (!isLastWindow) {
    const confirmed = await openSystemModalAsync({
      parent: window,
      spec: {
        title: 'Close Window',
        message: stopsLocalComfy
          ? 'Close this window? This stops the running ComfyUI instance.'
          : 'Close this window?',
        confirmLabel: 'Close Window',
        cancelLabel: 'Cancel',
        confirmStyle: 'danger',
        theme,
      },
    })
    return confirmed ? 'close' : 'cancel'
  }
  const action = await openSystemModalChoiceAsync({
    parent: window,
    spec: {
      title: 'Close Window',
      message: stopsLocalComfy
        ? 'This is the last window. Closing it stops ComfyUI and quits Desktop, or you can return to the dashboard.'
        : 'This is the last window. Closing it quits Desktop, or you can return to the dashboard.',
      confirmLabel: 'Quit Desktop',
      secondaryLabel: 'Return to Dashboard',
      secondaryStyle: 'primary',
      cancelLabel: 'Cancel',
      confirmStyle: 'danger',
      theme,
    },
  })
  if (action === 'confirm') return 'close'
  if (action === 'secondary') return 'return-to-dashboard'
  return 'cancel'
}

/**
 * Confirm + close a single install-backed host window. Model downloads are owned by the
 * desktop app, not the instance, so they keep running after a close (no active-download
 * list here). Closing the last window quits Desktop; the confirm offers "Return to
 * Dashboard" so the user isn't forced to quit.
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
  // Confirm when closing kills a local ComfyUI process OR when this is the last install
  // window (closing it quits the app, so the user gets the prompt + the dashboard escape).
  // Cloud/remote non-last windows and chooser hosts close immediately.
  if (shouldConfirmKillForEntry(entry) || (isLastWindow && isInstallHost(entry))) {
    const choice = await confirmCloseInstanceWindow(
      entry.window,
      isLastWindow,
      shouldConfirmKillForEntry(entry),
      entry.lastTheme,
    )
    if (choice === 'cancel') return
    if (choice === 'return-to-dashboard') {
      // Flip the last window to the dashboard rather than closing it (which would quit).
      entry.detachInstall()
      return
    }
  }
  // Skip the close handler's consult: the user already confirmed via this prompt.
  preClearedClose.add(entry.window)
  entry.window.close()
}

/**
 * Flip an install-backed host window in place to install-less (chooser) mode: the symmetric
 * undo to `attachInstall()`, bound onto `entry.detachInstall` by `createHostWindow()`. Runs
 * `_installCleanup`, navigates the comfyView to about:blank (kept alive for re-attach),
 * resets + re-pushes the title-bar identity, and remounts the panel in chooser mode. No-op
 * when already install-less; does NOT destroy the comfyView or window.
 */
export function _detachInstallImpl(entry: ComfyWindowEntry): void {
  if (isChooserHost(entry)) return
  if (entry.window.isDestroyed()) return

  // Returning to the dashboard makes it the active surface — persist so the
  // next boot opens the dashboard, not the install we just detached. The
  // record helper no-ops while quitting (the user's last surface is whatever
  // they left from).
  recordDashboardSurface()

  // Symmetric undo of attachInstall (listeners, maps, stopRunning, etc).
  entry._installCleanup?.()

  // Release the ComfyUI page; the view is kept alive for re-attach.
  if (!entry.comfyView.webContents.isDestroyed()) {
    void entry.comfyView.webContents.loadURL('about:blank').catch(() => {})
    entry.comfyView.setBackgroundColor(COMFY_BG)
  }

  // Flip identity back to chooser-host shape and push every identity-derived signal: the
  // title bar doesn't reload across attach/detach, so without these the renderer keeps the
  // stale install identity.
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
    // Reset the install-scoped update pill to "no update" so it clears immediately instead
    // of inheriting the prior install's pending-update flag.
    entry.titleBarView.webContents.send('comfy-titlebar:install-update-changed', {
      available: false,
      version: null,
    })
  }
  applyChooserHostTheme(entry)

  // Tear down the install-backed PanelApp and remount fresh in chooser mode, preserving no
  // per-install state.
  destroyPanelView(entry)
  ensurePanelView(entry.windowKey, entry, 'chooser')
  entry.layoutViews()
}

/**
 * Detach every install-backed host whose backing install is no longer in `liveIds` (delete
 * / untrack paths), else it keeps rendering chrome for a non-existent install. Snapshots
 * the entry list so a synchronous detach mutating `comfyWindows` doesn't skip entries.
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
