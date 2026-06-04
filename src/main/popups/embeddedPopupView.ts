import { WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'
import { _registerExtraBroadcastTarget } from '../lib/ipc/broadcast'

/**
 * Lifecycle primitive for a transparent popup `WebContentsView` attached to a host BrowserWindow's
 * content area (title-bar tooltip, system modal, title-bar dropdown). Construction costs ~100ms, so
 * consumers cache one per parent and reuse it. This class owns construct/attach/load/teardown and
 * tracks `rendererReady` / `isOpen` / `pendingShowTimer`.
 */
export interface EmbeddedPopupViewOpts {
  parent: BrowserWindow
  /** HTML basename without extension, resolved to the dev URL or packaged renderer file. */
  htmlName: string
  /** Preload basename, resolved against `__dirname/../preload/`. */
  preloadName: string
  /** Initial bounds; almost always overwritten by the consumer's first show. */
  initialBounds: Electron.Rectangle
  /** Parent events that should call `hide()` (click-outside / drag-to-move dismiss). */
  hideOnParentEvents?: ReadonlyArray<'blur' | 'will-move' | 'move' | 'resize'>
  /** Also `hide()` when the popup webContents loses focus. */
  hideOnPopupBlur?: boolean
  /** Called from the parent's `closed` event before teardown, to drop consumer index entries. */
  onParentClosed?: () => void
  /** Called from the popup's `destroyed` event (fires on independent destruction, e.g. renderer crash). */
  onDestroyed?: () => void
  /** Called from `hide()` on any transition out of open/pending (manual or auto-dismiss). */
  onHide?: () => void
}

export class EmbeddedPopupView {
  readonly popup: WebContentsView
  readonly parentWindow: BrowserWindow
  /** Snapshotted at construction: the parent's `closed` event fires after child webContents are
   *  destroyed, so reading `popup.webContents.id` there would throw. */
  readonly popupWebContentsId: number
  readonly parentWindowId: number
  /** True once the consumer has observed the renderer's `:ready` IPC. */
  rendererReady = false
  /** True between `showOnTop()` and `hide()`. */
  isOpen = false
  /** Open-in-flight timer waiting for the renderer `:rendered` ack; shows anyway so it never sticks invisible. */
  pendingShowTimer: NodeJS.Timeout | null = null
  /** Opt-out of blur-dismiss (the picker owns its own outside-click; blur-dismiss would cause open→reopen flicker). */
  suppressBlurDismiss = false
  private readonly onHideCallback?: () => void

  constructor(opts: EmbeddedPopupViewOpts) {
    const { parent } = opts
    this.parentWindow = parent
    this.parentWindowId = parent.id
    this.onHideCallback = opts.onHide

    const popup = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/', opts.preloadName),
      },
    })
    // Per-pixel transparency so only the popup's card paints; the rest alpha-blends to the body view.
    popup.setBackgroundColor('#00000000')
    popup.setVisible(false)
    popup.setBounds(opts.initialBounds)
    parent.contentView.addChildView(popup)
    this.popup = popup
    this.popupWebContentsId = popup.webContents.id

    // Opt the popup into main's broadcast fan-out (getAllWindows only reaches top-level windows).
    _registerExtraBroadcastTarget(popup.webContents)

    const isDev = !!process.env['ELECTRON_RENDERER_URL']
    const loadPromise = isDev
      ? popup.webContents.loadURL(
          `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/${opts.htmlName}.html`,
        )
      : popup.webContents.loadFile(path.join(__dirname, `../renderer/${opts.htmlName}.html`))
    void loadPromise.catch(() => {})

    const dismiss = (): void => {
      // `suppressBlurDismiss` covers every auto-dismiss path; see the field docstring.
      if (this.suppressBlurDismiss) return
      this.hide()
    }
    // Cast through a minimal emitter shape: BrowserWindow's overloaded `on` typings don't unify in a loop.
    type DismissEmitter = {
      on(event: string, listener: () => void): void
      removeListener(event: string, listener: () => void): void
    }
    const dismissEvents = opts.hideOnParentEvents ?? []
    const parentEmitter = parent as unknown as DismissEmitter
    const parentListeners = new Map<string, () => void>()
    for (const event of dismissEvents) {
      parentListeners.set(event, dismiss)
      parentEmitter.on(event, dismiss)
    }
    if (opts.hideOnPopupBlur) {
      popup.webContents.on('blur', dismiss)
    }

    const onParentClosed = (): void => {
      opts.onParentClosed?.()
      try { parent.contentView.removeChildView(popup) } catch {}
      if (!popup.webContents.isDestroyed()) popup.webContents.close()
    }
    parent.once('closed', onParentClosed)

    popup.webContents.once('destroyed', () => {
      if (!parent.isDestroyed()) {
        for (const event of dismissEvents) {
          const listener = parentListeners.get(event)
          if (listener) parentEmitter.removeListener(event, listener)
        }
        parent.removeListener('closed', onParentClosed)
      }
      opts.onDestroyed?.()
    })
  }

  /** True when either the popup or its parent has been destroyed. */
  isDestroyed(): boolean {
    return this.popup.webContents.isDestroyed() || this.parentWindow.isDestroyed()
  }

  /** Re-add the popup as the top-most child view so it paints above other views, then show it. */
  showOnTop(opts: { focus?: boolean } = {}): void {
    if (this.pendingShowTimer) {
      clearTimeout(this.pendingShowTimer)
      this.pendingShowTimer = null
    }
    if (this.popup.webContents.isDestroyed()) return
    if (!this.parentWindow.isDestroyed()) {
      try { this.parentWindow.contentView.removeChildView(this.popup) } catch {}
      this.parentWindow.contentView.addChildView(this.popup)
    }
    this.popup.setVisible(true)
    if (opts.focus) this.popup.webContents.focus()
    this.isOpen = true
  }

  /** Hide the popup (safe when not visible). Fires `onHide` on an actual transition. */
  hide(opts: { focusParent?: boolean } = {}): void {
    if (!this.isOpen && !this.pendingShowTimer) return
    this.isOpen = false
    if (this.pendingShowTimer) {
      clearTimeout(this.pendingShowTimer)
      this.pendingShowTimer = null
    }
    if (!this.popup.webContents.isDestroyed()) {
      this.popup.setVisible(false)
      if (opts.focusParent && !this.parentWindow.isDestroyed()) {
        this.parentWindow.focus()
      }
    }
    this.onHideCallback?.()
  }

  /** Run `callback()` after `timeoutMs` (clears any prior timer); a fallback for when the `:rendered` ack never arrives. */
  scheduleShowFallback(timeoutMs: number, callback: () => void): void {
    if (this.pendingShowTimer) clearTimeout(this.pendingShowTimer)
    this.pendingShowTimer = setTimeout(() => {
      this.pendingShowTimer = null
      callback()
    }, timeoutMs)
  }

  /** Cancel the pending show-fallback timer, if any. */
  cancelPendingShow(): void {
    if (this.pendingShowTimer) {
      clearTimeout(this.pendingShowTimer)
      this.pendingShowTimer = null
    }
  }
}
