import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { buildElectronApi } from './api'

export type ComfyPanelKey =
  | 'comfy'
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

/** Single download entry surfaced by the title-bar tray.
 *  Mirror of the main-side `DownloadProgress` shape, kept in sync via
 *  `comfy-titlebar:downloads-changed` push. The title bar renders only
 *  a status-icon + filename + progress percent — it doesn't need
 *  byte counters or speed/ETA, so this interface stays minimal. */
export interface DownloadsTrayEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

/** Payload pushed by main on `comfy-titlebar:downloads-changed`.
 *  `active` is every in-flight (`pending` / `downloading` / `paused`)
 *  download; `recent` is the last N terminal entries (oldest first),
 *  capped server-side. The tray icon hides entirely when both arrays
 *  are empty. */
export interface DownloadsTrayState {
  active: DownloadsTrayEntry[]
  recent: DownloadsTrayEntry[]
}

export interface ComfyTitleBarBridge {
  /** The installation this title bar belongs to. */
  getInstallationId(): string | null
  /** Whether the host is macOS — controls left padding for traffic lights. */
  isMac(): boolean
  /** Request the main process to swap the active panel. */
  setPanel(panel: ComfyPanelKey): void
  /** File menu → "New Window". Opens a fresh install-less chooser
   *  host window. Always creates a new one — the focus-existing path
   *  lives on the tray entry. */
  openNewWindow(): void
  /** Pop the File menu as a native OS menu. Avoids HTML popups that
   *  would be clipped by the title bar's WebContentsView bounds. */
  openFileMenu(anchor: TitleMenuAnchor): void
  /** Ask main to dismiss the File menu popup. Used to toggle the menu
   *  closed when the user reclicks the menu button while it is open
   *  — on macOS the blur-driven dismiss isn't reliable for sibling
   *  WebContentsView clicks. */
  dismissFileMenu(): void

  /** Subscribe to panel-active changes coming from main. */
  onPanelChanged(cb: (panel: ComfyPanelKey) => void): () => void
  /** Subscribe to title text changes coming from main. */
  onTitleChanged(cb: (title: string) => void): () => void
  /** Subscribe to install source-category pushes from main. The raw
   *  category string (e.g. `'local'`, `'cloud'`,
   *  `'desktop'`) drives the install-type icon in the title bar via
   *  the renderer's `installTypeMetaFor()` helper. `null` for
   *  install-less host windows or when the install's source can't be
   *  resolved — the renderer suppresses the icon entirely in that
   *  case. */
  onSourceCategoryChanged(cb: (category: string | null) => void): () => void
  /** Subscribe to theme updates (background + symbol color). */
  onThemeChanged(cb: (theme: { bg: string; text: string }) => void): () => void
  /** Subscribe to macOS fullscreen state — drives traffic-light padding. */
  onFullscreenChanged(cb: (fullscreen: boolean) => void): () => void
  /** Subscribe to native title-bar menu open events. Fires when the
   *  popup becomes visible. The renderer uses this to track open
   *  state so a click on the menu button while open is suppressed
   *  (the blur-driven dismiss handles the close on its own). On
   *  macOS the click event can fire before the dismiss propagates,
   *  so a timestamp-only guard isn't reliable. */
  onMenuOpened(
    cb: (info: { menu: 'menu' | 'downloads' | 'instance-picker' }) => void,
  ): () => void
  /** Subscribe to title-bar popup close events. Fires when the popup
   *  view (waffle menu, downloads tray, OR instance-picker) closes,
   *  after the user picks an item or dismisses by clicking outside.
   *  The renderer uses this to suppress an immediate re-open if the
   *  same click that dismissed the popup also re-targets the opener
   *  button. The payload carries which kind closed so the per-button
   *  reopen guards stay independent. */
  onMenuClosed(
    cb: (info: { menu: 'menu' | 'downloads' | 'instance-picker' }) => void,
  ): () => void
  /** Subscribe to first-use takeover step changes. Mode mirrors
   *  `firstUseMode` on the entry — `'none'` for no takeover mounted,
   *  `'consent-lockdown'` while the T&C consent step is on screen,
   *  `'post-consent'` for any later step. The title bar locks down
   *  during `'consent-lockdown'`. */
  onFirstUseModeChanged(
    cb: (mode: 'none' | 'consent-lockdown' | 'post-consent') => void,
  ): () => void
  /** Subscribe to app-update state pushes (status pills). `kind` is
   *  `'available'` after `update-available`, `'ready'` after
   *  `update-downloaded`, and `null` when nothing is pending. Drives
   *  the title-bar app-update pill that sits to the right of the
   *  hamburger menu.
   *
   *  `autoUpdate` mirrors the `autoUpdate` setting at the moment the
   *  state was committed. With auto-updates ON the
   *  `'available'` pill is suppressed entirely (main triggers the
   *  download itself); the `'ready'` pill then reads "Update will
   *  apply on restart". With auto-updates OFF the `'available'` pill
   *  reads "Update v{version} available" and the `'ready'` pill keeps
   *  the existing "Restart to update" copy. */
  onAppUpdateStateChanged(
    cb: (state: {
      kind: 'available' | 'downloading' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void,
  ): () => void
  /** Subscribe to install-update state pushes (status pills).
   *  `available` is `true` when the install's
   *  `statusTag.style === 'update'`, `false` otherwise; `version`
   *  carries the target release version when known so the pill can
   *  read "Update v{version}" instead of the generic
   *  "Update available". Only relevant on install-backed host
   *  windows; install-less hosts never receive this signal. */
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
  /** Subscribe to downloads-tray state pushes from main.
   *  Initial push happens on `onTitleBarReady` (both install-backed
   *  and chooser-host branches) so the tray renders correctly even
   *  when a title bar mounts AFTER an in-flight download started. */
  onDownloadsChanged(cb: (state: DownloadsTrayState) => void): () => void
  /** Click handler for the downloads tray. Opens the title-bar
   *  dropdown popup in `'downloads'` mode anchored under the tray
   *  button. */
  clickDownloadsTray(anchor: TitleMenuAnchor): void
  /** Click handler for the centre install pill. Opens the title-bar
   *  dropdown popup in `'instance-picker'` mode anchored below the
   *  pill. Main filters install-less hosts (chooser body) — for those
   *  hosts the click silently no-ops, matching the design call:
   *  the dashboard already IS the picker. */
  clickInstallPill(anchor: TitleMenuAnchor): void
  /** Click handler for the title-bar Send Feedback button. Main
   *  resolves the host entry from the sender and forwards
   *  `comfy-panel:open-feedback` to the panel renderer, which fires
   *  the `desktop2.feedback.opened` telemetry action and opens the
   *  support URL via `openExternal`. */
  clickFeedback(): void
  /** Issue #514 — show the title-bar hover tooltip popup. Routed
   *  through main, which positions a cached `WebContentsView` popup
   *  attached to the host window so the bubble escapes the title-bar
   *  view's 37px clip. Only fired on macOS (Win/Linux use the native
   *  HTML `title` attribute, which works in those platforms'
   *  Chromium); macOS doesn't reliably surface native title tooltips
   *  for sibling chrome WebContentsViews that aren't focused.
   *
   *  `leftX` / `rightX` are the trigger's horizontal edges in
   *  title-bar-local pixels — title-bar lives at window x=0 so they
   *  also map to window coordinates. Main prefers to anchor the
   *  bubble's left edge to `leftX` so the tooltip extends rightward
   *  from the trigger (matches native macOS / browser tooltips for
   *  small icon buttons in the leading edge of a chrome bar). When
   *  that would overflow the parent's right edge it falls back to
   *  anchoring the bubble's right edge to `rightX` instead.
   *  `bottomY` is the trigger's bottom edge for the same coordinate
   *  space; main offsets the popup a few pixels below it. */
  showTooltip(payload: { text: string; leftX: number; rightX: number; bottomY: number }): void
  /** Issue #514 — hide the title-bar hover tooltip popup. Sent on
   *  pointer leave, focus loss, menu open, or panel switch. */
  hideTooltip(): void
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
  dismissFileMenu: () => {
    ipcRenderer.send('comfy-window:dismiss-title-menu')
  },

  onPanelChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, panel: unknown): void => {
      if (typeof panel === 'string') cb(panel as ComfyPanelKey)
    }
    ipcRenderer.on('comfy-titlebar:panel-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:panel-changed', handler)
  },
  onTitleChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, title: unknown): void => {
      if (typeof title === 'string') cb(title)
    }
    ipcRenderer.on('comfy-titlebar:title-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:title-changed', handler)
  },
  onSourceCategoryChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, category: unknown): void => {
      cb(typeof category === 'string' ? category : null)
    }
    ipcRenderer.on('comfy-titlebar:source-category-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:source-category-changed', handler)
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
  onMenuOpened: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      // Forward only the menu kinds the title-bar renderer knows about.
      // Without `'instance-picker'` here the pill's `is-open` state
      // never flips true and the brand-yellow lift doesn't fire.
      if (menu === 'menu' || menu === 'downloads' || menu === 'instance-picker') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-opened', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-opened', handler)
  },
  onMenuClosed: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      if (menu === 'menu' || menu === 'downloads' || menu === 'instance-picker') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-closed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-closed', handler)
  },
  onFirstUseModeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, mode: unknown): void => {
      const normalised = mode === 'consent-lockdown' || mode === 'post-consent' ? mode : 'none'
      cb(normalised)
    }
    ipcRenderer.on('comfy-titlebar:first-use-mode-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:first-use-mode-changed', handler)
  },
  onAppUpdateStateChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { kind?: unknown; version?: unknown; autoUpdate?: unknown }
      const kind =
        data.kind === 'available' || data.kind === 'downloading' || data.kind === 'ready'
          ? data.kind
          : null
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
  onDownloadsChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { active?: unknown; recent?: unknown }
      const active = Array.isArray(data.active) ? (data.active as DownloadsTrayEntry[]) : []
      const recent = Array.isArray(data.recent) ? (data.recent as DownloadsTrayEntry[]) : []
      cb({ active, recent })
    }
    ipcRenderer.on('comfy-titlebar:downloads-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:downloads-changed', handler)
  },
  clickDownloadsTray: (anchor) => {
    ipcRenderer.send('comfy-window:click-downloads-tray', { anchor })
  },
  clickInstallPill: (anchor) => {
    ipcRenderer.send('comfy-window:click-install-pill', { anchor })
  },
  clickFeedback: () => {
    ipcRenderer.send('comfy-window:click-feedback')
  },
  showTooltip: (payload) => {
    ipcRenderer.send('comfy-window:show-titlebar-tooltip', payload)
  },
  hideTooltip: () => {
    ipcRenderer.send('comfy-window:hide-titlebar-tooltip')
  },
  ready: () => {
    ipcRenderer.send('comfy-window:title-bar-ready')
  },
}


// Expose the standard window.api bridge alongside __comfyTitleBar so the
// title-bar renderer can call initializeRendererBootstrap() (which depends
// on window.api.getSetting / getDeviceId / onTelemetrySettingChanged /
// etc.). Without this, telemetry only fired from the panel renderer (which
// only mounts in chooser/lifecycle modes), leaving steady-state ComfyUI
// sessions invisible to Datadog and PostHog.
//
// The shared ./api import is safe here because the title-bar
// WebContentsView opts out of the sandbox via sandbox: false in
// src/main/index.ts. Sandboxed preloads can only require() from a
// whitelist (electron, events, timers, url); the chunked require of
// out/preload/chunks/api-*.js that Rollup emits would fail there. See
// issue #521 for the planned build-time chunk-inlining plugin that
// will let us re-enable sandbox without source duplication.
const api = buildElectronApi()

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleBar', bridge)
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleBar = bridge
  ;(globalThis as Record<string, unknown>).api = api
}
