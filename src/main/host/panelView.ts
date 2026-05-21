import { WebContentsView, ipcMain } from 'electron'
import path from 'path'
import { resolveTheme } from '../lib/ipc/shared'
import { get as getSetting } from '../settings'
import { TITLEBAR_BG } from '../lib/theme'
import { TITLEBAR_HEIGHT, titleBarOverlayForTheme } from '../lib/titleBarOverlay'
import {
  _registerExtraBroadcastTarget,
  _unregisterExtraBroadcastTarget,
} from '../lib/ipc/shared'
import {
  bringToFront,
  comfyWindows,
  computeBodyMode,
  findEntryByTitleBarSender,
  getEntryByInstallationId,
  VALID_PANELS,
} from './registry'
import type { BodyMode, ComfyPanelKey, ComfyWindowEntry } from './registry'

/**
 * Lazily create the panel WebContentsView for a comfy window. Adds it as a
 * sibling of comfyView, registers it for broadcasts, and loads panel.html
 * with the installation context as URL parameters.
 *
 * The URL params are only an initial hint — `did-finish-load` always re-pushes
 * the current `activePanel` so a user who clicks Install Settings then
 * Launcher Settings before the first load completes still ends up on the
 * latter. This guards against the mid-load race.
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
      // sandbox: false — preload/index.js imports the shared
      // src/preload/api.ts chunk, same as the title-bar preload.
      // Sandboxed preloads can't require() relative chunks, so leaving
      // sandbox on would silently break window.api in the panel and
      // take renderer-side telemetry with it. See issue #521 for the
      // build-time inlining plugin that will let us turn sandbox back on.
      sandbox: false,
      // Reuse the launcher preload — panel UI uses window.api like the main launcher window.
      preload: path.join(__dirname, '../preload/index.js'),
      // Default session (no partition) — keeps the panel isolated from the
      // ComfyUI frontend's storage even though it runs in the same window.
    },
  })
  // Chooser/lifecycle paint `var(--bg)` in the renderer; use an opaque
  // launcher-surface colour during load so the host window doesn't read
  // as empty black while panel.html boots. Overlay modes (settings-v2)
  // need transparency to composite the live comfyView through.
  const chooserPanelBg = (): string => {
    const overlay = titleBarOverlayForTheme(resolveTheme() === 'dark')
    return overlay.color ?? TITLEBAR_BG
  }
  panelView.setBackgroundColor(initialPanel === 'chooser' ? chooserPanelBg() : '#00000000')
  entry.window.contentView.addChildView(panelView)
  // Insert at zero size, behind the comfy view; layoutViews handles positioning.
  panelView.setBounds({ x: 0, y: TITLEBAR_HEIGHT + 1, width: 0, height: 0 })
  panelView.setVisible(false)

  // Push the *latest* body mode (may differ from initialPanel if the user
  // clicked between buttons during the first load, or the running state
  // changed) and steal focus if the window is focused.
  panelView.webContents.once('did-finish-load', () => {
    const latest = comfyWindows.get(windowKey)
    if (!latest || latest.window.isDestroyed() || panelView.webContents.isDestroyed()) return
    if (latest.coldStartPendingReveal) {
      latest.coldStartPendingReveal = false
      latest.layoutViews()
      bringToFront(latest.window)
    }
    const mode = computeBodyMode(latest)
    if (mode !== 'comfy') {
      panelView.webContents.send('panel-switch', { panel: mode, installationId: latest.installationId ?? '' })
      if (latest.window.isFocused()) panelView.webContents.focus()
    }
  })

  // Pass the entry's installationId (which is the empty string for
  // install-less host windows) to the panel renderer — the Map key is a
  // numeric windowKey that PanelApp.vue must not see.
  const panelInstallationId = entry.installationId ?? ''
  const firstUseCompleted = getSetting('firstUseCompleted') === true
  const panelQuery = {
    installationId: panelInstallationId,
    panel: initialPanel,
    firstUseCompleted: String(firstUseCompleted),
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
  // Loads can reject if the window closes mid-load — swallow to avoid noisy
  // unhandledRejection forwarding from the main-process error handlers.
  void loadPromise.catch(() => {})

  _registerExtraBroadcastTarget(panelView.webContents)
  entry.panelView = panelView
  return panelView
}

/**
 * Tear down the entry's current panelView (if any) so the next
 * `ensurePanelView()` call rebuilds it fresh. Used by the chooser-pick
 * in-place attach path (`onLaunch`) to drop the chooser PanelApp —
 * including any in-flight launch progress overlay it was holding —
 * before the install takes over the host. Without this, the
 * still-mounted chooser panel's overlay state would survive the
 * attach, hidden behind the live comfyView, and a later
 * `consultPanelRendererClose` (window close) would funnel through
 * its cancel-prompt and hang waiting for input the user can't see.
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
}

/** Move OS focus to whichever body view is now active so keyboard input lands in the right place. */
export function focusActiveBody(entry: ComfyWindowEntry): void {
  if (entry.window.isDestroyed() || !entry.window.isFocused()) return
  const mode = computeBodyMode(entry)
  if (mode === 'comfy') {
    if (!entry.comfyView.webContents.isDestroyed()) entry.comfyView.webContents.focus()
  } else if (entry.panelView && !entry.panelView.webContents.isDestroyed() && !entry.panelView.webContents.isLoadingMainFrame()) {
    // Panel exists and is loaded — focus immediately. If still loading, the
    // did-finish-load handler in ensurePanelView will focus it.
    entry.panelView.webContents.focus()
  }
}

export function setActivePanel(windowKey: number, panel: ComfyPanelKey): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel === panel) return

  entry.activePanel = panel
  const mode = computeBodyMode(entry)
  // Broadcast every body-mode change to the panel renderer — including
  // 'comfy'. Without the 'comfy' broadcast the renderer's activePanel ref
  // goes stale after a drawer close and the next open no-ops.
  if (mode !== 'comfy') {
    ensurePanelView(windowKey, entry, mode)
  }
  forwardToPanelRenderer(entry, 'panel-switch', { panel: mode, installationId: entry.installationId ?? '' })
  entry.layoutViews()
  if (!entry.titleBarView.webContents.isDestroyed()) {
    // Title bar pill stays on the user-visible key, not 'comfy-lifecycle'.
    entry.titleBarView.webContents.send('comfy-titlebar:panel-changed', panel)
  }
  focusActiveBody(entry)
}

/**
 * Re-evaluate the body mode for a comfy window after a session-state
 * transition (instance launched / stopped / crashed) and reflect it in the
 * layout. When the body mode is `'comfy-lifecycle'`, the panelView is created
 * (if needed) and asked to render the lifecycle UI; the title-bar pill stays
 * on `'comfy'` either way.
 */
export function refreshComfyTabBody(installationId: string): void {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel !== 'comfy') return

  const mode = computeBodyMode(entry)
  if (mode === 'comfy-lifecycle') {
    ensurePanelView(entry.windowKey, entry, 'comfy-lifecycle')
  }
  // Tell an already-mounted panel renderer about the new body mode so it
  // unmounts/mounts the lifecycle view in step with main's state.
  forwardToPanelRenderer(entry, 'panel-switch', { panel: mode, installationId })
  entry.layoutViews()
  focusActiveBody(entry)
}

/**
 * Send a payload to a panelView, deferring until `did-finish-load` if
 * the bundle is still loading. Centralizes the deferral pattern so
 * pill clicks / IPC that land during the lazy first-load aren't
 * silently dropped before the renderer's listener wires up.
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

  // Page-level X close (rendered inside the panel WebContentsView, e.g.
  // Settings / Directories / Install Settings) — same effect as a pill
  // click: the body returns to the comfy/chooser root. The panel preload
  // exposes this as `closeCurrentPanel()`. We resolve the host window via
  // the panel's WebContents sender; the panelView is lazily created so we
  // walk every entry instead of caching a separate reverse-map.
  ipcMain.on('comfy-window:close-current-panel', (event) => {
    for (const [id, entry] of comfyWindows) {
      if (entry.panelView?.webContents === event.sender) {
        setActivePanel(id, 'comfy')
        return
      }
    }
  })

  // Title-bar Settings icon close → forward to the panel renderer so
  // the drawer's leave animation plays before `activePanel` flips.
  // Same dismiss path as ESC / backdrop click.
  ipcMain.on('comfy-window:request-close-drawer', (event) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    forwardToPanelRenderer(found.entry, 'panel:request-close-drawer')
  })
}
