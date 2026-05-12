import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * Title-tooltip popup bridge.
 *
 * The title-bar's hover tooltips are rendered inside a transparent
 * `WebContentsView` attached to the host window so they escape the
 * title-bar view's 37px clip. macOS Chromium does not reliably surface
 * native HTML `title` tooltips for sibling chrome WebContentsViews that
 * aren't the focused view (issue #514), so we render our own.
 *
 * The popup view is reused across hovers (created once per parent
 * window, hidden between shows) so showing feels instant after the
 * first paint. Each show arrives as a `comfy-titletooltip:set-config`
 * IPC carrying the text and theme; main repositions the view via
 * `setBounds` and flips it visible after the renderer acks paint.
 */
export interface TitleTooltipConfig {
  text: string
  theme: { bg: string; text: string; border: string }
  /** Round-trip token. Echoed verbatim by the renderer in
   *  `notifyRendered` so main can discard render-acks that don't
   *  match the most recently sent config (e.g. a fast pointer move
   *  fired a new set-config while the previous one was still being
   *  painted — the stale ack would otherwise show the popup with
   *  outdated text at the new anchor). */
  configToken: string
}

export interface ComfyTitleTooltipBridge {
  /** Signal that the renderer is mounted and listening — main flushes
   *  any config that was queued before the renderer was ready. */
  ready(): void
  /** Signal that the renderer has applied the latest config and the
   *  new DOM has painted. Main waits for this before flipping the
   *  popup visible so the user never sees a frame of the previous
   *  tooltip's text on a new show. `configToken` echoes the token
   *  from the corresponding `set-config` push so main can discard
   *  stale acks. */
  notifyRendered(payload: { width: number; height: number; configToken: string }): void
  /** Subscribe to config pushes (one fires per show). */
  onConfig(cb: (config: TitleTooltipConfig) => void): () => void
}

function isTooltipConfig(value: unknown): value is TitleTooltipConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<TitleTooltipConfig>
  if (typeof v.text !== 'string') return false
  if (typeof v.configToken !== 'string') return false
  if (!v.theme || typeof v.theme !== 'object') return false
  if (typeof v.theme.bg !== 'string') return false
  if (typeof v.theme.text !== 'string') return false
  if (typeof v.theme.border !== 'string') return false
  return true
}

const bridge: ComfyTitleTooltipBridge = {
  ready: () => {
    ipcRenderer.send('comfy-titletooltip:ready')
  },
  notifyRendered: (payload) => {
    ipcRenderer.send('comfy-titletooltip:rendered', payload)
  },
  onConfig: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      if (isTooltipConfig(data)) cb(data)
    }
    ipcRenderer.on('comfy-titletooltip:set-config', handler)
    return () => ipcRenderer.removeListener('comfy-titletooltip:set-config', handler)
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleTooltip', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleTooltip = bridge
}
