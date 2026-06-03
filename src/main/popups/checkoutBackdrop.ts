import { WebContentsView, ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

/**
 * Dim + blur scrim painted behind the credits-checkout popup.
 *
 * The checkout is a separate, floating child `BrowserWindow` (its page
 * forbids iframing, so it can't be an in-window view). To make it read
 * as a focused modal rather than a stray second window, we darken the
 * host window underneath it. A separate OS window floats above ALL of
 * the parent's content views, so a transparent `WebContentsView` added
 * to the parent's `contentView` sits correctly *under* the popup.
 *
 * Clicking the scrim dismisses the checkout (modal click-outside), via
 * the per-parent `onDismiss` callback passed to `showCheckoutBackdrop`.
 *
 * Independent of the title-popup backdrop (`titlePopup.ts`) on purpose:
 * that one drives the picker / global-settings popups; this one is
 * dedicated to the checkout window's lifecycle.
 */

interface CheckoutBackdropEntry {
  view: WebContentsView
  visible: boolean
  onDismiss: (() => void) | null
}

const backdropsByParent = new Map<number, CheckoutBackdropEntry>()
const parentByWebContents = new Map<number, number>()

/** Fixed scrim: a translucent dim with a blur so the host chrome reads
 *  as a frosted background behind the checkout. Tint matches the app's
 *  title-bar color (`#211927` / neutral-800) at 0.4 so the background
 *  stays clearly visible through it. A click anywhere fires the dismiss
 *  IPC. */
const CHECKOUT_BACKDROP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;user-select:none}
  .scrim{position:fixed;inset:0;width:100%;height:100%;background:rgba(33,25,39,0.4);backdrop-filter:blur(8px) saturate(120%);-webkit-backdrop-filter:blur(8px) saturate(120%);cursor:default}
</style></head><body>
<div class="scrim" id="s"></div>
<script>
  const { ipcRenderer } = require('electron');
  document.getElementById('s').addEventListener('mousedown', () => {
    ipcRenderer.send('comfy-checkout-backdrop:dismiss');
  });
</script>
</body></html>`

let ipcWired = false
function ensureIpc(): void {
  if (ipcWired) return
  ipcWired = true
  ipcMain.on('comfy-checkout-backdrop:dismiss', (event) => {
    const parentId = parentByWebContents.get(event.sender.id)
    if (parentId == null) return
    const entry = backdropsByParent.get(parentId)
    if (!entry || !entry.visible) return
    entry.onDismiss?.()
  })
}

function fullBounds(parent: BrowserWindow): Electron.Rectangle {
  const cb = parent.getContentBounds()
  return { x: 0, y: 0, width: cb.width, height: cb.height }
}

function ensureBackdrop(parent: BrowserWindow): CheckoutBackdropEntry {
  const existing = backdropsByParent.get(parent.id)
  if (existing && !existing.view.webContents.isDestroyed()) return existing

  ensureIpc()
  const view = new WebContentsView({
    webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false },
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
  parent.contentView.addChildView(view)
  void view.webContents
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(CHECKOUT_BACKDROP_HTML)}`)
    .catch(() => {})

  const entry: CheckoutBackdropEntry = { view, visible: false, onDismiss: null }
  backdropsByParent.set(parent.id, entry)
  parentByWebContents.set(view.webContents.id, parent.id)

  // Keep the scrim fitted to the host's content area while visible so it
  // doesn't leak past the edges or leave an undimmed strip on resize.
  parent.on('resize', () => {
    if (!entry.visible || parent.isDestroyed() || view.webContents.isDestroyed()) return
    view.setBounds(fullBounds(parent))
  })
  parent.once('closed', () => {
    if (!view.webContents.isDestroyed()) view.webContents.close()
    parentByWebContents.delete(view.webContents.id)
    backdropsByParent.delete(parent.id)
  })

  return entry
}

/** Show the dim scrim over `parent`, re-stacked to the top of its
 *  content views (still below the separate popup window). `onDismiss`
 *  fires when the user clicks the scrim (click-outside-to-close). */
export function showCheckoutBackdrop(parent: BrowserWindow, onDismiss: () => void): void {
  if (parent.isDestroyed()) return
  const entry = ensureBackdrop(parent)
  entry.onDismiss = onDismiss
  entry.view.setBounds(fullBounds(parent))
  // Re-stack so the scrim sits above comfyView / titleBarView.
  try {
    parent.contentView.removeChildView(entry.view)
    parent.contentView.addChildView(entry.view)
  } catch {
    /* noop */
  }
  entry.view.setVisible(true)
  entry.visible = true
}

/** Hide the scrim and detach it so it can't intercept input. */
export function hideCheckoutBackdrop(parent: BrowserWindow): void {
  const entry = backdropsByParent.get(parent.id)
  if (!entry || !entry.visible) return
  entry.visible = false
  entry.onDismiss = null
  if (entry.view.webContents.isDestroyed()) return
  entry.view.setVisible(false)
  if (!parent.isDestroyed()) {
    try {
      parent.contentView.removeChildView(entry.view)
    } catch {
      /* noop */
    }
  }
}
