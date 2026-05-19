import { WebContentsView } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'

/**
 * Lifecycle primitive shared by every "transparent popup attached to
 * a host BrowserWindow's content area" used in the title bar / shell:
 *
 *   - the title-bar hover tooltip (`titleTooltip.ts`),
 *   - the system-level confirm modal (`systemModal.ts`),
 *   - the title-bar dropdown (waffle menu / downloads tray)
 *     (`titlePopup.ts`).
 *
 * Constructing a `WebContentsView` + loading its HTML costs ~100ms,
 * so each consumer caches one popup view per parent BrowserWindow and
 * reuses it across opens. This class owns that lifecycle:
 *
 *   - constructs the transparent `WebContentsView` with a per-popup
 *     preload + initial bounds,
 *   - attaches it as a child of the parent's `contentView`,
 *   - loads the dev URL (when `ELECTRON_RENDERER_URL` is set) or
 *     packaged HTML file,
 *   - tears down with the parent window (drops listeners, removes
 *     the child view, closes the popup webContents),
 *   - tracks `rendererReady` / `isOpen` / `pendingShowTimer` so the
 *     consumer's render-ack handlers can flip visibility safely.
 *
 * The consumer keeps its own typed entry record (current spec, item
 * list, last-synced JSON, ...) and routes IPC by `popupWebContentsId`.
 */
export interface EmbeddedPopupViewOpts {
  parent: BrowserWindow
  /** HTML basename without extension, e.g. `'comfyTitlePopup'`. Resolved
   *  to `${ELECTRON_RENDERER_URL}/${htmlName}.html` in dev or
   *  `__dirname/../renderer/${htmlName}.html` in packaged builds. */
  htmlName: string
  /** Preload basename, resolved against `__dirname/../preload/`. */
  preloadName: string
  /** Initial WebContentsView bounds. Almost always overwritten by the
   *  consumer's first show; use small placeholder bounds so the hidden
   *  view doesn't occupy real estate during the construction race. */
  initialBounds: Electron.Rectangle
  /** Parent BrowserWindow events that should call `hide()` (the
   *  click-outside / drag-to-move dismiss path used by the hover
   *  tooltip and dropdown popups). */
  hideOnParentEvents?: ReadonlyArray<'blur' | 'will-move' | 'move' | 'resize'>
  /** Also call `hide()` when the popup webContents loses focus —
   *  click-outside on a sibling view inside the same parent window. */
  hideOnPopupBlur?: boolean
  /** Called from the parent's `closed` event before the popup is torn
   *  down. Use to drop the consumer's index entries (by-parent /
   *  by-webContents maps). */
  onParentClosed?: () => void
  /** Called from the popup webContents's `destroyed` event. Fires when
   *  the popup is destroyed independently of its parent (renderer
   *  crash) so the consumer can drop stale index entries. */
  onDestroyed?: () => void
  /** Called from `hide()` whenever it actually transitions out of the
   *  open/pending state — covers both manual hides and the auto-dismiss
   *  paths wired via `hideOnParentEvents` / `hideOnPopupBlur`. Use it
   *  when the consumer must run cleanup on every dismissal regardless
   *  of trigger (e.g. titlePopup sends `comfy-titlebar:menu-closed` so
   *  the title-bar renderer's reopen-suppression guard fires). */
  onHide?: () => void
}

export class EmbeddedPopupView {
  readonly popup: WebContentsView
  readonly parentWindow: BrowserWindow
  /** Snapshotted at construction. The parent's `closed` event fires
   *  *after* its child WebContentsViews' webContents are destroyed,
   *  so accessing `popup.webContents.id` there would throw "Object has
   *  been destroyed". */
  readonly popupWebContentsId: number
  readonly parentWindowId: number
  /** True once the consumer has observed the renderer's `:ready` IPC. */
  rendererReady = false
  /** True between `showOnTop()` and `hide()`. */
  isOpen = false
  /** Set when an open is in flight, waiting for the renderer's
   *  `:rendered` ack before flipping to visible. The fallback timer
   *  shows the popup anyway after a short window so it never gets
   *  permanently stuck invisible if the ack never arrives (mid-load
   *  crash, etc.). */
  pendingShowTimer: NodeJS.Timeout | null = null
  /** Owner-toggled opt-out for the blur-driven dismiss path. The
   *  picker sets this to true while open because it owns its own
   *  outside-click handling via a full-body backdrop view — the
   *  blur-based dismiss would race the toggle-close click and cause
   *  open → immediate-reopen flicker. Other popup kinds leave this
   *  false so blur dismissal continues to work for them. */
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
    // Per-pixel transparency so the popup's rounded card / dim backdrop
    // is the only visible surface — the area around it lets the body
    // view show through. Works because WebContentsView alpha-blends
    // into its parent BrowserWindow's opaque surface.
    popup.setBackgroundColor('#00000000')
    popup.setVisible(false)
    popup.setBounds(opts.initialBounds)
    parent.contentView.addChildView(popup)
    this.popup = popup
    this.popupWebContentsId = popup.webContents.id

    const isDev = !!process.env['ELECTRON_RENDERER_URL']
    const loadPromise = isDev
      ? popup.webContents.loadURL(
          `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/${opts.htmlName}.html`,
        )
      : popup.webContents.loadFile(path.join(__dirname, `../renderer/${opts.htmlName}.html`))
    void loadPromise.catch(() => {})

    const dismiss = (): void => {
      // `suppressBlurDismiss` covers EVERY auto-dismiss path
      // (parent:blur / parent:will-move / parent:move / parent:resize /
      // popup:blur). The picker owns its own outside-click handling
      // via the backdrop view; any of these auto-paths firing during
      // the open transition would close the popup and immediately
      // re-open on the trigger click → visible flicker. Owners that
      // want the auto-dismiss back can leave the flag false.
      if (this.suppressBlurDismiss) return
      this.hide()
    }
    // BrowserWindow's overloaded `on(event, listener)` typings narrow the
    // listener to a per-event signature, so a `for` loop over a list of
    // event names doesn't unify. Cast through a minimal emitter shape —
    // the dismiss listener takes no args so the runtime call is safe.
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

  /** Re-add the popup as the most recently attached child view so it
   *  paints above the title-bar / comfy / panel views, then flip it
   *  visible. Optionally focuses the popup webContents (interactive
   *  popups want this so keyboard input lands inside; the hover
   *  tooltip does not). Cancels any pending show-fallback timer. */
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

  /** Hide the popup. Safe to call when not currently visible. Cancels
   *  any pending show-fallback timer. Fires the constructor's `onHide`
   *  callback when an actual transition happens (so consumers can run
   *  per-dismissal cleanup regardless of whether the user called
   *  `hide()` manually or one of the auto-dismiss listeners fired). */
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

  /** Schedule a fallback that runs `callback()` after `timeoutMs`.
   *  Clears any prior pending timer. Consumers typically use this to
   *  show the popup after a short window when the renderer's `:rendered`
   *  ack never arrives, so the popup never gets permanently stuck
   *  invisible. */
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
