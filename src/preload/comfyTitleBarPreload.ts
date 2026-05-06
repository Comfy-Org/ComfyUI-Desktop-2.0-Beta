import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

export type ComfyPanelKey =
  | 'comfy'
  | 'install-settings'
  | 'launcher-settings'
  | 'directories'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

/** Anchor coordinates for a native title-bar menu — title-bar-local
 *  pixels (x = button left, y = button bottom). The titleBarView sits
 *  at window y=0 so these coordinates double as window coordinates in
 *  main. */
export interface TitleMenuAnchor {
  x: number
  y: number
}

export interface ComfyTitleBarBridge {
  /** The installation this title bar belongs to. */
  getInstallationId(): string | null
  /** Whether the host is macOS — controls left padding for traffic lights. */
  isMac(): boolean
  /** Request the main process to swap the active panel. */
  setPanel(panel: ComfyPanelKey): void
  /** File menu → "New Window" (Phase 3 title bar v2). Opens a fresh
   *  install-less chooser host window. Always creates a new one — the
   *  focus-existing path lives on the tray entry. */
  openNewWindow(): void
  /** Pop the File menu as a native OS menu. Avoids HTML popups that
   *  would be clipped by the title bar's WebContentsView bounds. */
  openFileMenu(anchor: TitleMenuAnchor): void
  /** Pop the Install caret menu as a native OS menu. No-op for
   *  install-less host windows (main filters by sender's entry). */
  openInstallMenu(anchor: TitleMenuAnchor): void
  /** Browser-style Back arrow — step one entry backward in the host
   *  window's panel-history stack. No-op when at the root. */
  goBack(): void
  /** Browser-style Forward arrow — step one entry forward in history.
   *  No-op when there's nothing to redo (i.e. user hasn't pressed Back). */
  goForward(): void
  /** Subscribe to panel-active changes coming from main. */
  onPanelChanged(cb: (panel: ComfyPanelKey) => void): () => void
  /** Subscribe to navigation-state changes (Back/Forward enabledness). */
  onNavStateChanged(cb: (state: { canBack: boolean; canForward: boolean }) => void): () => void
  /** Subscribe to title text changes coming from main. */
  onTitleChanged(cb: (title: string) => void): () => void
  /** Subscribe to theme updates (background + symbol color). */
  onThemeChanged(cb: (theme: { bg: string; text: string }) => void): () => void
  /** Subscribe to macOS fullscreen state — drives traffic-light padding. */
  onFullscreenChanged(cb: (fullscreen: boolean) => void): () => void
  /** Subscribe to native title-bar menu close events. Fires when the
   *  popup created by `openFileMenu` / `openInstallMenu` closes, after
   *  the user picks an item or dismisses by clicking outside. The
   *  renderer uses this to suppress an immediate re-open if the same
   *  click that dismissed the menu also re-targets the menu button. */
  onMenuClosed(cb: (info: { menu: 'file' | 'install' }) => void): () => void
  /** Subscribe to inert-state changes (Phase 3 §17 Tier 3 takeover).
   *  When the panel renderer's overlay tier flips into or out of 3,
   *  main forwards the boolean here. Drives `is-inert` styling on the
   *  title bar and disables interactive controls (file menu, install
   *  pill, back/forward) so a takeover can't be dismissed via the
   *  title bar. Window controls (× / □) stay live — they're OS
   *  affordances outside this view. */
  onInertChanged(cb: (inert: boolean) => void): () => void
  /** Subscribe to app-update state pushes (Phase 3 §18 status pills).
   *  `kind` is `'available'` after `update-available`, `'ready'` after
   *  `update-downloaded`, and `null` when nothing is pending. Drives
   *  the title-bar app-update pill that sits to the right of the
   *  hamburger menu.
   *
   *  Track B item 2 — `autoUpdate` mirrors the `autoUpdate` setting
   *  at the moment the state was committed. With auto-updates ON the
   *  `'available'` pill is suppressed entirely (main triggers the
   *  download itself); the `'ready'` pill then reads "Update will
   *  apply on restart". With auto-updates OFF the `'available'` pill
   *  reads "Update v{version} available" and the `'ready'` pill keeps
   *  the existing "Restart to update" copy. */
  onAppUpdateStateChanged(
    cb: (state: {
      kind: 'available' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void,
  ): () => void
  /** Subscribe to install-update state pushes (Phase 3 §18 status
   *  pills). `available` is `true` when the install's
   *  `statusTag.style === 'update'`, `false` otherwise; `version`
   *  carries the target release version when known so the pill can
   *  read "Update v{version}" instead of the generic
   *  "Update available" (Track B item 1). Only relevant on
   *  install-backed host windows; install-less hosts never receive
   *  this signal. */
  onInstallUpdateAvailable(
    cb: (state: { available: boolean; version: string | null }) => void,
  ): () => void
  /** Click handler for the app-update pill. Main responds by sending
   *  `panel-trigger-overlay` to the host's panelView so the renderer
   *  can open the app-update popover via `openOverlay`. */
  clickAppUpdatePill(): void
  /** Click handler for the install-update pill. Main routes the
   *  request to the host's panelView with the entry's installationId
   *  so the renderer can open the manage overlay on the update tab. */
  clickInstallUpdatePill(): void
  /** Tell main this title bar is mounted; main responds with the initial state. */
  ready(): void
}

// `window` and `navigator` are available at preload time but the node tsconfig
// omits the DOM lib; access them via globalThis to keep the type-checker happy.
interface PreloadGlobals {
  location?: { href: string }
  navigator?: { userAgent: string }
}
const g = globalThis as unknown as PreloadGlobals

function readInstallationId(): string | null {
  try {
    const href = g.location?.href
    if (!href) return null
    return new URL(href).searchParams.get('installationId')
  } catch {
    return null
  }
}

const bridge: ComfyTitleBarBridge = {
  getInstallationId: () => readInstallationId(),
  isMac: () => (g.navigator?.userAgent ?? '').toLowerCase().includes('mac'),
  setPanel: (panel) => {
    ipcRenderer.send('comfy-window:set-panel', { panel })
  },
  openNewWindow: () => {
    ipcRenderer.send('comfy-window:new-chooser-window')
  },
  openFileMenu: (anchor) => {
    ipcRenderer.send('comfy-window:open-title-menu', { menu: 'file', anchor })
  },
  openInstallMenu: (anchor) => {
    ipcRenderer.send('comfy-window:open-title-menu', { menu: 'install', anchor })
  },
  goBack: () => {
    ipcRenderer.send('comfy-window:go-back')
  },
  goForward: () => {
    ipcRenderer.send('comfy-window:go-forward')
  },
  onPanelChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, panel: unknown): void => {
      if (typeof panel === 'string') cb(panel as ComfyPanelKey)
    }
    ipcRenderer.on('comfy-titlebar:panel-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:panel-changed', handler)
  },
  onNavStateChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { canBack, canForward } = (data || {}) as { canBack?: unknown; canForward?: unknown }
      cb({ canBack: !!canBack, canForward: !!canForward })
    }
    ipcRenderer.on('comfy-titlebar:nav-state-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:nav-state-changed', handler)
  },
  onTitleChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, title: unknown): void => {
      if (typeof title === 'string') cb(title)
    }
    ipcRenderer.on('comfy-titlebar:title-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:title-changed', handler)
  },
  onThemeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { bg, text } = (data || {}) as { bg?: string; text?: string }
      if (typeof bg === 'string' && typeof text === 'string') cb({ bg, text })
    }
    ipcRenderer.on('comfy-titlebar:theme-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:theme-changed', handler)
  },
  onFullscreenChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, fullscreen: unknown): void => {
      cb(!!fullscreen)
    }
    ipcRenderer.on('comfy-titlebar:fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:fullscreen-changed', handler)
  },
  onMenuClosed: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      if (menu === 'file' || menu === 'install') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-closed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-closed', handler)
  },
  onInertChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, inert: unknown): void => {
      cb(!!inert)
    }
    ipcRenderer.on('comfy-titlebar:inert-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:inert-changed', handler)
  },
  onAppUpdateStateChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { kind?: unknown; version?: unknown; autoUpdate?: unknown }
      const kind = data.kind === 'available' || data.kind === 'ready' ? data.kind : null
      const version = typeof data.version === 'string' ? data.version : null
      // Default-on if main forgets to send it — matches the underlying
      // `settings.get('autoUpdate') !== false` semantics.
      const autoUpdate = data.autoUpdate !== false
      cb({ kind, version, autoUpdate })
    }
    ipcRenderer.on('comfy-titlebar:app-update-state-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:app-update-state-changed', handler)
  },
  onInstallUpdateAvailable: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { available?: unknown; version?: unknown }
      const available = !!data.available
      const version = typeof data.version === 'string' ? data.version : null
      cb({ available, version })
    }
    ipcRenderer.on('comfy-titlebar:install-update-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:install-update-changed', handler)
  },
  clickAppUpdatePill: () => {
    ipcRenderer.send('comfy-window:click-app-update-pill')
  },
  clickInstallUpdatePill: () => {
    ipcRenderer.send('comfy-window:click-install-update-pill')
  },
  ready: () => {
    ipcRenderer.send('comfy-window:title-bar-ready')
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleBar', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleBar = bridge
}
