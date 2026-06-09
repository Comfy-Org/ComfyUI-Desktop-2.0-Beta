import { WebContentsView, ipcMain } from 'electron'
import path from 'path'
import { resolveTheme } from '../lib/ipc/shared'
import { get as getSetting } from '../settings'
import { TITLEBAR_BG } from '../lib/theme'
import { TITLEBAR_HEIGHT, titleBarOverlayForTheme } from '../lib/titleBarOverlay'
import {
  _registerExtraBroadcastTarget,
  _unregisterExtraBroadcastTarget,
  _activeOperationStatus,
} from '../lib/ipc/shared'
import {
  comfyWindows,
  computeBodyMode,
  findEntryByTitleBarSender,
  getEntryByInstallationId,
  revealColdStartHostIfPending,
  VALID_PANELS,
} from './registry'
import type { BodyMode, ComfyPanelKey, ComfyWindowEntry } from './registry'

/** Opaque panel background matching the title-bar chrome, used while the panel
 *  bundle loads for full-screen bodies so the user never sees a black flash. */
function opaquePanelBg(): string {
  const overlay = titleBarOverlayForTheme(resolveTheme() === 'dark')
  return overlay.color ?? TITLEBAR_BG
}

/** Full-screen bodies that hide the comfy view, so the panel must paint opaque
 *  during load rather than compositing the (hidden) canvas through. `comfy-
 *  lifecycle` is included so the 1-2s `stopping` window shows the spinner over
 *  an opaque surface instead of black. Overlay modes (downloads / feedback)
 *  deliberately stay transparent. */
function isOpaqueBodyMode(mode: BodyMode): boolean {
  return mode === 'chooser' || mode === 'new-install' || mode === 'comfy-lifecycle'
}

/**
 * Lazily create the panel WebContentsView for a comfy window. The URL params are only an
 * initial hint; `did-finish-load` always re-pushes the current `activePanel` to guard
 * against a mid-load race where the user clicks between buttons before the first load ends.
 */
export function ensurePanelView(
  windowKey: number,
  entry: ComfyWindowEntry,
  initialPanel: BodyMode,
): WebContentsView {
  if (entry.panelView) return entry.panelView

  const panelView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // preload/index.js imports the shared window.api chunk; a sandboxed preload can't
      // require() relative chunks, which would break window.api in the panel.
      sandbox: false,
      preload: path.join(__dirname, '../preload/index.js'),
      // Default session (no partition) keeps the panel isolated from ComfyUI's storage.
    },
  })
  panelView.setBackgroundColor(isOpaqueBodyMode(initialPanel) ? opaquePanelBg() : '#00000000')
  entry.window.contentView.addChildView(panelView)
  // Insert at zero size, behind the comfy view; layoutViews handles positioning.
  panelView.setBounds({ x: 0, y: TITLEBAR_HEIGHT + 1, width: 0, height: 0 })
  panelView.setVisible(false)

  // Push the latest body mode (may differ from initialPanel) and steal focus if focused.
  panelView.webContents.once('did-finish-load', () => {
    const latest = comfyWindows.get(windowKey)
    if (!latest || latest.window.isDestroyed() || panelView.webContents.isDestroyed()) return
    // Backstop reveal for the rare case where the titlebar load is delayed past the panel's.
    revealColdStartHostIfPending(windowKey)
    const mode = computeBodyMode(latest)
    if (mode !== 'comfy') {
      panelView.webContents.send('panel-switch', { panel: mode, installationId: latest.installationId ?? '' })
      if (latest.window.isFocused()) panelView.webContents.focus()
    }
  })

  // Pass installationId ('' for install-less hosts), not the numeric windowKey map key.
  const panelInstallationId = entry.installationId ?? ''
  const firstUseCompleted = getSetting('firstUseCompleted') === true
  const panelQuery: Record<string, string> = {
    installationId: panelInstallationId,
    panel: initialPanel,
    firstUseCompleted: String(firstUseCompleted),
  }
  // Propagate the E2E flag via the URL query (the renderer can't read process.env) so the
  // renderer-side test hooks only register when the runner opted in.
  if (process.env['E2E'] === '1') {
    panelQuery['e2e'] = '1'
  }
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  const loadPromise = isDev
    ? panelView.webContents.loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/panel.html?${new URLSearchParams(panelQuery).toString()}`,
      )
    : panelView.webContents.loadFile(
        path.join(__dirname, '../renderer/panel.html'),
        { query: panelQuery },
      )
  // Loads can reject if the window closes mid-load; swallow to avoid noisy forwarding.
  void loadPromise.catch(() => {})

  _registerExtraBroadcastTarget(panelView.webContents)
  entry.panelView = panelView
  return panelView
}

/**
 * Tear down the entry's current panelView so the next `ensurePanelView()` rebuilds it
 * fresh. The chooser-pick attach path uses this to drop the chooser PanelApp (and any
 * in-flight overlay) before the install takes over; otherwise a later close consult would
 * hang on the hidden panel's cancel-prompt waiting for input the user can't see.
 */
export function destroyPanelView(entry: ComfyWindowEntry): void {
  if (!entry.panelView) return
  const oldPanel = entry.panelView
  entry.panelView = null
  if (!oldPanel.webContents.isDestroyed()) {
    _unregisterExtraBroadcastTarget(oldPanel.webContents)
    oldPanel.webContents.close()
  }
  if (!entry.window.isDestroyed()) {
    try { entry.window.contentView.removeChildView(oldPanel) } catch {}
  }
  // The rebuilt panel starts with no overlay, so any `firstUseMode` the old renderer pushed
  // is stale. Reset to `'none'` and broadcast so the title bar paints full chrome; the new
  // renderer re-pushes if onboarding is still active.
  if (entry.firstUseMode !== 'none') {
    entry.firstUseMode = 'none'
    if (!entry.titleBarView.webContents.isDestroyed()) {
      entry.titleBarView.webContents.send('comfy-titlebar:first-use-mode-changed', 'none')
    }
  }
}

/** Move OS focus to whichever body view is now active so keyboard input lands in the right place. */
export function focusActiveBody(entry: ComfyWindowEntry): void {
  if (entry.window.isDestroyed() || !entry.window.isFocused()) return
  const mode = computeBodyMode(entry)
  if (mode === 'comfy') {
    if (!entry.comfyView.webContents.isDestroyed()) entry.comfyView.webContents.focus()
  } else if (entry.panelView && !entry.panelView.webContents.isDestroyed() && !entry.panelView.webContents.isLoadingMainFrame()) {
    // If still loading, ensurePanelView's did-finish-load handler focuses it instead.
    entry.panelView.webContents.focus()
  }
}

export function setActivePanel(windowKey: number, panel: ComfyPanelKey): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel === panel) return

  entry.activePanel = panel
  const mode = computeBodyMode(entry)
  // Broadcast every body-mode change including 'comfy', else the renderer's activePanel ref
  // goes stale after a drawer close and the next open no-ops.
  if (mode !== 'comfy') {
    ensurePanelView(windowKey, entry, mode)
  }
  forwardToPanelRenderer(entry, 'panel-switch', { panel: mode, installationId: entry.installationId ?? '' })
  entry.layoutViews()
  if (!entry.titleBarView.webContents.isDestroyed()) {
    // Pill stays on the user-visible key, not 'comfy-lifecycle'.
    entry.titleBarView.webContents.send('comfy-titlebar:panel-changed', panel)
  }
  focusActiveBody(entry)
}

/**
 * Re-evaluate the body mode after a session-state transition and reflect it in the layout.
 * When the mode is `'comfy-lifecycle'`, the panelView renders the lifecycle UI; the pill
 * stays on `'comfy'` either way.
 */
export function refreshComfyTabBody(installationId: string): void {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel !== 'comfy') return
  // A background op (inline picker update/restore) is managing this lifecycle; don't flash
  // the "not running" screen while it's in-flight.
  const bgOp = _activeOperationStatus.get(installationId)
  if (bgOp && !bgOp.done) return

  const mode = computeBodyMode(entry)
  if (mode === 'comfy-lifecycle') {
    const lifecyclePanel = ensurePanelView(entry.windowKey, entry, 'comfy-lifecycle')
    // Re-force opaque in case the panel was first created transparent (overlay/
    // comfy mode); otherwise the hidden canvas shows black until Vue paints.
    if (!lifecyclePanel.webContents.isDestroyed()) {
      lifecyclePanel.setBackgroundColor(opaquePanelBg())
    }
  }
  forwardToPanelRenderer(entry, 'panel-switch', { panel: mode, installationId })
  entry.layoutViews()
  focusActiveBody(entry)
}

/**
 * Send a payload to a panelView, deferring until `did-finish-load` if the bundle is still
 * loading, so IPC landing during the lazy first-load isn't dropped before the listener wires up.
 */
export function sendToPanelDeferred(
  panelView: WebContentsView,
  channel: string,
  payload: unknown,
): void {
  if (panelView.webContents.isDestroyed()) return
  const send = (): void => {
    if (panelView.webContents.isDestroyed()) return
    panelView.webContents.send(channel, payload)
  }
  if (panelView.webContents.isLoadingMainFrame()) {
    panelView.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

/** Forward an IPC to the entry's panel renderer, no-op if absent. */
function forwardToPanelRenderer(
  entry: ComfyWindowEntry,
  channel: string,
  payload?: unknown,
): void {
  const pv = entry.panelView
  if (!pv || pv.webContents.isDestroyed()) return
  sendToPanelDeferred(pv, channel, payload)
}

/** Wire the panel-routing IPC handlers. Called once at app `whenReady`. */
export function registerPanelViewIpc(): void {
  ipcMain.on('comfy-window:set-panel', (event, payload: { panel: string }) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    const panel = payload?.panel as ComfyPanelKey
    if (!VALID_PANELS.has(panel)) return
    setActivePanel(found.id, panel)
  })

  // Page-level X close inside the panel: same effect as a pill click. Resolve the host via
  // the panel's WebContents sender (walking entries, since the panelView is lazily created).
  ipcMain.on('comfy-window:close-current-panel', (event) => {
    for (const [id, entry] of comfyWindows) {
      if (entry.panelView?.webContents === event.sender) {
        setActivePanel(id, 'comfy')
        return
      }
    }
  })

}
