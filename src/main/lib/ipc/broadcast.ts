import { BrowserWindow } from 'electron'

/**
 * Extra WebContents (e.g. WebContentsView-hosted panels and custom title bars)
 * that should also receive broadcasts. `BrowserWindow.getAllWindows()` only
 * surfaces top-level windows — child WebContentsViews must be registered here
 * to receive `'theme-changed'`, `'locale-changed'`, `'release-cache-enriched'`,
 * etc. Auto-cleaned on `webContents.destroyed`.
 *
 * This module is intentionally tiny and dependency-free so it can be imported
 * from leaf modules (e.g. `embeddedPopupView.ts`) without pulling in the rest
 * of the IPC handler universe.
 */
const _extraBroadcastTargets = new Set<Electron.WebContents>()

export function _registerExtraBroadcastTarget(wc: Electron.WebContents): void {
  _extraBroadcastTargets.add(wc)
  wc.once('destroyed', () => _extraBroadcastTargets.delete(wc))
}

export function _unregisterExtraBroadcastTarget(wc: Electron.WebContents): void {
  _extraBroadcastTargets.delete(wc)
}

export function _broadcastToRenderer(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  })
  for (const wc of _extraBroadcastTargets) {
    if (!wc.isDestroyed()) wc.send(channel, data)
  }
}
