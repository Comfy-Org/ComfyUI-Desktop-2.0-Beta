import * as ipc from '../lib/ipc'
import { getAppVersion } from '../lib/ipc'
import { attachSessionDownloadHandler } from '../lib/comfyDownloadManager'
import { getModelDownloadContentScript } from '../lib/comfyContentScript'
import { _operationAborts, sourceMap } from '../lib/ipc/shared'
import { TITLEBAR_BG } from '../lib/theme'
import * as mainTelemetry from '../lib/telemetry'
import { refreshCloudUserTier } from '../lib/userTier'
import { forwardDatadogError } from '../lib/processErrorHandlers'
import { installationEvents, type InstallationRecord } from '../installations'
import {
  dropInstallationIndex,
  indexInstallationId,
  isInstallHost,
  setLastFocusedInstallationId,
} from './registry'
import type { ComfyWindowEntry } from './registry'

const APP_VERSION = getAppVersion()

/** Lifecycle-state maps owned by `index.ts` that `attachInstall` and the
 *  related relaunch flow both touch. Late-bound via
 *  `setAttachFactories(...)` so a future move of these maps doesn't
 *  require re-touching every call site. */
export interface AttachFactories {
  /** Per-install backoff cancel for the comfyContents `did-fail-load`
   *  retry timer. The relaunch flow uses this to interrupt a pending
   *  retry that would otherwise navigate away from the splash page. */
  comfyFailRetryTimerCancels: Map<string, () => void>
  /** Per-install relaunch state. Keys present in this map gate every
   *  attach-side reload path so a relaunch-in-progress install can't
   *  be auto-retried out from under the splash. */
  relaunchStates: Map<string, unknown>
  /** Compute whether an install has a pending in-app update. Used to
   *  push the title-bar install-update pill on attach + on every
   *  install-record `'updated'` event. */
  computeInstallUpdateAvailable: (
    installationId: string,
  ) => Promise<{ available: boolean; version?: string }>
}

let factories: AttachFactories | null = null

export function setAttachFactories(opts: AttachFactories): void {
  factories = opts
}

function getFactories(): AttachFactories {
  if (!factories) {
    throw new Error('setAttachFactories must be called before attachInstall')
  }
  return factories
}

export interface AttachInstallOpts {
  installation: InstallationRecord
  comfyUrl: string
  /**
   * `true` for locally-launched installs (no `url` arg); `false` for
   * remote / cloud installs. Drives the `__comfyDesktop2Remote` flag
   * the content script reads at top-of-page so remote-only behaviours
   * (e.g. cloud-storage prompts) gate correctly.
   */
  isLocal: boolean
}

/**
 * Bind an install to a freshly-constructed (or detached) host entry.
 * Wires every install-keyed listener — install-record subscription,
 * theme observer, fail-retry, render-process-gone, before-input
 * keystrokes, attachSessionDownloadHandler, content-script injection
 * — and stashes a symmetric undo on `entry._installCleanup`
 * (consumed by the close handler and by `detachInstall()`).
 *
 * Calling on an already-attached entry throws — callers must detach
 * first or construct a fresh window. The cleanup is idempotent
 * (calling it twice is a no-op the second time) so the close
 * handler is free to invoke it without checking detach state.
 */
export function attachInstall(entry: ComfyWindowEntry, opts: AttachInstallOpts): boolean {
  if (isInstallHost(entry)) {
    // Defensive — every current call site already gates with
    // `isChooserHost(entry)`, but a future caller that forgets
    // the guard would otherwise take down the entire launch flow
    // with an uncaught exception in main. Surface the violation
    // to telemetry and let the caller fall back (the install-
    // backed wrapper destroys the just-created host; the claim
    // path skips the in-place attach and the wrapper recovers).
    const message =
      `attachInstall: entry windowKey=${entry.windowKey} is already attached to ` +
      `installationId=${entry.installationId}; detach first`
    console.error(message)
    forwardDatadogError({
      source: 'attach-install-already-attached',
      message,
      level: 'error',
      context: {
        origin: 'main-process',
        windowKey: String(entry.windowKey),
        existingInstallationId: entry.installationId,
        attemptedInstallationId: opts.installation.id,
      },
    })
    return false
  }
  const fx = getFactories()
  const { installation, comfyUrl, isLocal } = opts
  const installationId = installation.id
  const comfyContents = entry.comfyView.webContents
  const comfyWindow = entry.window
  const titleBarView = entry.titleBarView

  // Seed entry install state. The secondary index is the source of
  // truth for `getEntryByInstallationId(id)` — keep it in lockstep
  // with `entry.installationId` (detach symmetrically clears both).
  entry.installationId = installationId
  entry.comfyUrl = comfyUrl
  entry.titleBarText = installation.name
  entry.sourceCategory = sourceMap[installation.sourceId]?.category ?? null
  // The attach consumes any in-progress identity preview; clearing the
  // state field keeps a later detach from clobbering identity twice.
  entry.previewInstallationId = null
  indexInstallationId(installationId, entry.windowKey)

  // Seed the MRU tracker if this in-place attach happens on the
  // already-focused host: no fresh OS `'focus'` event would fire to
  // catch it otherwise, leaving the tracker pointing at a stale (or
  // null) install on the next dock-icon click.
  if (comfyWindow.isFocused()) {
    setLastFocusedInstallationId(installationId)
  }

  // OS-level window title is rebuilt whenever the page title or the
  // install name changes. Closures over the install lifetime — reset
  // by `_installCleanup` below.
  let currentInstallName = installation.name
  let currentPageTitle = ''
  const refreshOsWindowTitle = (): void => {
    if (comfyWindow.isDestroyed()) return
    const suffix = currentPageTitle ? ` — ${currentPageTitle}` : ''
    comfyWindow.setTitle(`${currentInstallName}${suffix} — Desktop 2.0 v${APP_VERSION}`)
  }
  refreshOsWindowTitle()

  // Push install-derived initial state — the title bar may already
  // be mounted (re-attach case). The shared title-bar-ready handshake
  // re-pushes from entry.* on a fresh mount, but the eager push covers
  // the in-place transform path.
  if (!titleBarView.webContents.isDestroyed()) {
    titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    titleBarView.webContents.send('comfy-titlebar:source-category-changed', entry.sourceCategory)
    // Flip the renderer's reactive `isInstallLess` to false so install-
    // scoped chrome (install-update pill, install-menu items) wakes up
    // without needing a title-bar URL reload.
    titleBarView.webContents.send('comfy-titlebar:installation-id-changed', installationId)
    // Cancel any active preview-mode state on the renderer so the
    // post-attach title bar drops back to the steady-state install
    // gating. No-op when no preview was pushed before this attach.
    titleBarView.webContents.send('comfy-titlebar:preview-mode-changed', false)
    void fx.computeInstallUpdateAvailable(installationId).then((state) => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
    })
  }

  // Reflect rename / source change in both the comfy tab and the
  // OS-level window title as the install record mutates. Also
  // recompute the install-update pill state (the install's source
  // may have flipped its statusTag between releases as the
  // release-cache resolves in the background).
  const onInstallationUpdated = (updated: InstallationRecord): void => {
    if (updated.id !== entry.installationId) return
    const nextTabText = updated.name
    if (nextTabText !== entry.titleBarText) {
      entry.titleBarText = nextTabText
      if (!titleBarView.webContents.isDestroyed()) {
        titleBarView.webContents.send('comfy-titlebar:title-changed', nextTabText)
      }
    }
    const nextCategory = sourceMap[updated.sourceId]?.category ?? null
    if (nextCategory !== entry.sourceCategory) {
      entry.sourceCategory = nextCategory
      if (!titleBarView.webContents.isDestroyed()) {
        titleBarView.webContents.send('comfy-titlebar:source-category-changed', nextCategory)
      }
    }
    if (updated.name !== currentInstallName) {
      currentInstallName = updated.name
      refreshOsWindowTitle()
    }
    void fx.computeInstallUpdateAvailable(updated.id).then((state) => {
      if (titleBarView.webContents.isDestroyed()) return
      titleBarView.webContents.send('comfy-titlebar:install-update-changed', state)
    })
  }
  installationEvents.on('updated', onInstallationUpdated)

  // Sync the title bar and overlay colors with the ComfyUI frontend's theme.
  // Currently locked to the dark title-bar palette regardless of the
  // reported bg/text — the app's title-bar surfaces (Vue pills,
  // dropdown popups, tooltips, OS overlay) are dark-only today, and
  // pushing a light bg into the OS overlay paints the min/max/close
  // symbols light over the still-dark Vue header. The arguments are
  // kept so the observer + ipc-message wiring stays intact for a
  // future re-introduction of theme tracking.
  const applyComfyTheme = (_bg: string, _text: string): void => {
    if (comfyWindow.isDestroyed()) return
    const theme = { bg: TITLEBAR_BG, text: '#dddddd' }
    entry.lastTheme = theme
    if (!titleBarView.webContents.isDestroyed()) {
      titleBarView.webContents.send('comfy-titlebar:theme-changed', theme)
    }
    if (process.platform !== 'darwin') {
      try { comfyWindow.setTitleBarOverlay({ color: theme.bg, symbolColor: theme.text }) } catch {}
    }
  }
  const onIpcMessage = (_event: Electron.IpcMainEvent, channel: string, ...args: unknown[]): void => {
    if (channel === 'desktop2-theme-report') {
      const { bg, text } = (args[0] || {}) as { bg?: string; text?: string }
      if (bg) applyComfyTheme(bg, text || '#ddd')
    }
  }
  comfyContents.on('ipc-message', onIpcMessage)

  const onPageTitleUpdated = (e: Electron.Event, title: string): void => {
    e.preventDefault()
    currentPageTitle = title
    refreshOsWindowTitle()
  }
  comfyContents.on('page-title-updated', onPageTitleUpdated)

  const COMFY_THEME_OBSERVER_JS =
    `(function(){` +
      `let last='';` +
      `function read(){` +
        `const s=getComputedStyle(document.body);` +
        `const bg=s.getPropertyValue('--comfy-menu-bg').trim();` +
        `const text=s.getPropertyValue('--descrip-text').trim();` +
        `const key=bg+'|'+text;` +
        `if(key!==last&&bg){last=key;window.__comfyDesktop2?.reportTheme?.(bg,text)}` +
      `}` +
      `new MutationObserver(()=>setTimeout(read,50)).observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','style']});` +
      `read();` +
    `})()`

  /**
   * Two cloud-only patches injected on every dom-ready of the comfy view:
   *
   *   1. popup-blocked toast suppressor — observes new toast DOM nodes
   *      and removes any that mention `auth/popup-blocked`. That error
   *      is fired by the cloud frontend's Firebase SDK every time our
   *      `setWindowOpenHandler` denies the auth popup (so the bridge
   *      can take over), and the user has no way to dismiss the toast
   *      in time before the bridge completes the sign-in.
   *
   *   2. post-signin flicker hide — when the bridge's IndexedDB inject
   *      flips a sessionStorage flag before `location.reload()`, this
   *      script hides documentElement for ~1s on the next load so the
   *      user doesn't see the cloud login page flash before the
   *      Firebase rehydrate redirects to the workspace.
   */
  const COMFY_CLOUD_PATCHES_JS =
    `(function(){` +
      `try{` +
        `if(sessionStorage.getItem('__comfyDesktopPostSignin')==='1'){` +
          `sessionStorage.removeItem('__comfyDesktopPostSignin');` +
          `var de=document.documentElement;` +
          `de.style.visibility='hidden';` +
          `setTimeout(function(){de.style.visibility=''},1000);` +
        `}` +
      `}catch(_){}` +
      `function looksBlocked(n){` +
        `if(!n||n.nodeType!==1)return false;` +
        `var t=(n.textContent||'').toLowerCase();` +
        `return t.indexOf('auth/popup-blocked')>=0;` +
      `}` +
      `function nukeToast(n){` +
        `var root=(n.closest&&n.closest('.p-toast-message,.p-toast-item,[role=alert]'))||n;` +
        `try{root.remove()}catch(_){}` +
      `}` +
      `new MutationObserver(function(muts){` +
        `for(var i=0;i<muts.length;i++){` +
          `var added=muts[i].addedNodes;` +
          `for(var j=0;j<added.length;j++){` +
            `var n=added[j];` +
            `if(looksBlocked(n)){nukeToast(n);continue;}` +
            `if(n.querySelectorAll){` +
              `var hits=n.querySelectorAll('*');` +
              `for(var k=0;k<hits.length;k++){` +
                `if(looksBlocked(hits[k])){nukeToast(hits[k]);break;}` +
              `}` +
            `}` +
          `}` +
        `}` +
      `}).observe(document.documentElement,{childList:true,subtree:true});` +
    `})()`

  const onDomReady = (): void => {
    comfyContents.executeJavaScript(COMFY_THEME_OBSERVER_JS).catch(() => {})
    const preamble = isLocal ? '' : 'window.__comfyDesktop2Remote = true;\n'
    comfyContents
      .executeJavaScript(preamble + getModelDownloadContentScript())
      .catch(() => {})
    // Cloud-only patches (popup-blocked toast suppression + post-signin
    // flicker hide). Skipped for local installs — they don't load cloud
    // frontend, never see the toast or the redirect flash.
    if (!isLocal) {
      comfyContents.executeJavaScript(COMFY_CLOUD_PATCHES_JS).catch(() => {})
      // Refresh the cached subscription tier off the cloud view's
      // Firebase auth record + /customers/me. Used by the capacity
      // kill-switch to let paying users through `disabled`. Fire-and-
      // forget — failures leave the tier cache as-is.
      void refreshCloudUserTier(comfyContents)
    }
  }
  comfyContents.on('dom-ready', onDomReady)

  // F5 / Ctrl+R reload — gated on the entry having an install backing
  // it (a detached host returns early so the dummy view can't reload
  // a stale URL).
  const currentComfyUrl = (): string => entry.comfyUrl || comfyUrl
  const reloadComfy = (): void => {
    if (comfyWindow.isDestroyed()) return
    const id = entry.installationId
    if (id === null) return
    if (fx.relaunchStates.has(id)) return
    comfyContents.stop()
    comfyContents.loadURL(currentComfyUrl())
  }
  const onBeforeInputEvent = (e: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && input.key.toLowerCase() === 'w') {
      e.preventDefault()
      return
    }
    if (input.key === 'F5' || (input.key.toLowerCase() === 'r' && mod)) {
      e.preventDefault()
      reloadComfy()
      return
    }
    // Restore Ctrl/Cmd + =/+/-/0 zoom on the comfy WebContentsView. The default
    // accelerators target BrowserWindow.webContents (empty since #414) and the
    // app menu has no View > Zoom roles, so we wire it explicitly here. Step
    // 0.5 mirrors Electron's standard zoomLevel granularity (~91% / 110% / ...).
    // Exclude Alt to avoid AltGr / Ctrl+Alt collisions on non-US layouts.
    //
    // NOTE on view hot-swapping: this handler closes over `comfyContents`
    // captured at attach time. Today, comfyView swaps happen only before
    // attachInstall runs, so the listener always lives on the active view and
    // `_installCleanup` removes it symmetrically. If we later hot-swap
    // entry.comfyView mid-attach (e.g. to reuse a host window without tearing
    // down install state), this binding goes stale and zoom shortcuts will
    // silently stop working until the next attach. The Reset Zoom menu item
    // re-reads parentEntry.comfyView at click time, so it stays correct.
    if (mod && !input.alt && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
      e.preventDefault()
      if (comfyContents.isDestroyed()) return
      if (input.key === '0') {
        const previousLevel = comfyContents.getZoomLevel()
        comfyContents.setZoomLevel(0)
        // Only emit when this was a real reset (skip no-op presses at 1x)
        // so the event count tracks actual recovery actions, not key-spam.
        if (previousLevel !== 0) {
          mainTelemetry.emit('desktop2.zoom.reset', {
            source: 'shortcut',
            parent_entry_id: entry.windowKey,
            installation_id: entry.installationId,
            previous_zoom_level: previousLevel,
            previous_zoom_percent: Math.round(Math.pow(1.2, previousLevel) * 100),
          })
        }
        return
      }
      const step = input.key === '-' ? -0.5 : 0.5
      comfyContents.setZoomLevel(comfyContents.getZoomLevel() + step)
    }
  }
  comfyContents.on('before-input-event', onBeforeInputEvent)

  // Failure retry — backoff on did-fail-load that isn't aborted /
  // mid-relaunch. Per-install timer cancel registered into the
  // shared map so onModelFolderRelaunch can interrupt a pending
  // retry that would otherwise navigate away from the splash page.
  let failRetryTimer: ReturnType<typeof setTimeout> | null = null
  const cancelFailRetry = (): void => {
    if (failRetryTimer) { clearTimeout(failRetryTimer); failRetryTimer = null }
  }
  fx.comfyFailRetryTimerCancels.set(installationId, cancelFailRetry)
  const onDidFailLoad = (
    _e: Electron.Event,
    code: number,
    _desc: string,
    _failUrl: string,
    isMainFrame: boolean,
  ): void => {
    if (!isMainFrame || code === -3 || failRetryTimer) return
    const id = entry.installationId
    if (id === null) return
    if (fx.relaunchStates.has(id)) return
    failRetryTimer = setTimeout(() => {
      failRetryTimer = null
      const currentId = entry.installationId
      if (currentId === null) return
      if (fx.relaunchStates.has(currentId)) return
      if (!comfyWindow.isDestroyed()) {
        comfyContents.loadURL(currentComfyUrl())
      }
    }, 2000)
  }
  comfyContents.on('did-fail-load', onDidFailLoad)

  const onRenderProcessGone = (
    _event: Electron.Event,
    details: Electron.RenderProcessGoneDetails,
  ): void => {
    forwardDatadogError({
      source: 'comfy-window-render-process-gone',
      message: `Comfy window renderer process exited (${details.reason})`,
      level: 'error',
      context: {
        origin: 'main-process',
        installationId: entry.installationId ?? '(detached)',
        reason: details.reason,
        exitCode: details.exitCode,
      },
    })
    reloadComfy()
  }
  comfyContents.on('render-process-gone', onRenderProcessGone)

  // Per-window download routing — attached at session level so a
  // download dispatched from the comfyContents lands in this
  // window's download tray. `detachWindowDownloads` is per-window
  // and survives mode flips (it lives in the createHostWindow close
  // handler, not in `_installCleanup`).
  attachSessionDownloadHandler(comfyContents.session)

  comfyContents.loadURL(comfyUrl)

  // Symmetric undo. Called by the close handler (always) and by
  // `detachInstall()` when the host flips back to chooser mode in
  // place. Idempotent — sets `_installCleanup = null` on first call
  // so subsequent calls are no-ops.
  entry._installCleanup = (): void => {
    if (entry._installCleanup === null) return
    entry._installCleanup = null
    installationEvents.off('updated', onInstallationUpdated)
    cancelFailRetry()
    if (!comfyContents.isDestroyed()) {
      comfyContents.off('ipc-message', onIpcMessage)
      comfyContents.off('page-title-updated', onPageTitleUpdated)
      comfyContents.off('dom-ready', onDomReady)
      comfyContents.off('did-fail-load', onDidFailLoad)
      comfyContents.off('render-process-gone', onRenderProcessGone)
      comfyContents.off('before-input-event', onBeforeInputEvent)
    }
    const id = entry.installationId
    if (id !== null) {
      // Abort any in-flight install / migrate / quick-install /
      // update-while-running op for this install BEFORE killing the
      // running session. Renderer-side overlay `onCancel` is the
      // happy-path rollback prompt; this is the safety net that
      // fires when the renderer side has no overlay mounted (e.g.
      // window-close consult returns `cleared: true` immediately
      // because the panel state is empty). Without it, in-flight
      // operations continued running orphaned in main after window teardown.
      const inFlight = _operationAborts.get(id)
      if (inFlight) {
        inFlight.abort()
        _operationAborts.delete(id)
      }
      // Detach the relaunch will-navigate blocker before clearing the
      // map slot — without `comfyContents.off(...)`, a re-attach would
      // inherit a still-active blocker that preventDefaults every
      // navigation until the comfyContents itself is destroyed.
      const relaunch = fx.relaunchStates.get(id) as
        | { navBlocker: (...args: unknown[]) => void }
        | undefined
      if (relaunch && !comfyContents.isDestroyed()) {
        comfyContents.off('will-navigate', relaunch.navBlocker)
      }
      ipc.stopRunning(id)
      fx.comfyFailRetryTimerCancels.delete(id)
      fx.relaunchStates.delete(id)
      dropInstallationIndex(id)
      entry.installationId = null
    }
    entry.comfyUrl = ''
  }
  return true
}
