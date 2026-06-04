import { BrowserWindow } from 'electron'

// Extra WebContents (panels, custom title bars) that also receive broadcasts;
// getAllWindows() only surfaces top-level windows. Auto-cleaned on destroy.
// Kept tiny and dependency-free so leaf modules can import it.
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
