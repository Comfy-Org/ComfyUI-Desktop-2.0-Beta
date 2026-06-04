import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

/**
 * Title-tooltip popup bridge. Hover tooltips render in a transparent WebContentsView
 * so they escape the title-bar view's clip; macOS Chromium doesn't reliably surface
 * native `title` tooltips for unfocused sibling chrome views. The view is reused
 * across hovers, driven by `comfy-titletooltip:set-config` pushes.
 */
export interface TitleTooltipConfig {
  /** `'tooltip'` (default) for the hover bubble; `'coachmark'` for the onboarding card. */
  variant?: 'tooltip' | 'coachmark'
  text?: string
  title?: string
  body?: string
  dismissLabel?: string
  theme: { bg: string; text: string; border: string; accent?: string }
  /** Echoed back in `notifyRendered` so main can discard stale render-acks. */
  configToken: string
}

export interface ComfyTitleTooltipBridge {
  /** Renderer is mounted; main flushes any config queued before ready. */
  ready(): void
  /** Renderer painted the latest config. Main waits for this before showing. */
  notifyRendered(payload: { width: number; height: number; configToken: string }): void
  onConfig(cb: (config: TitleTooltipConfig) => void): () => void
  /** Coachmark dismiss button; no-op for the tooltip variant. */
  dismissCoachmark(): void
}

function isTooltipConfig(value: unknown): value is TitleTooltipConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<TitleTooltipConfig>
  if (typeof v.configToken !== 'string') return false
  if (!v.theme || typeof v.theme !== 'object') return false
  if (typeof v.theme.bg !== 'string') return false
  if (typeof v.theme.text !== 'string') return false
  if (typeof v.theme.border !== 'string') return false
  // Coachmark needs title/body; tooltip needs text. One channel serves both.
  if (v.variant === 'coachmark') {
    if (typeof v.title !== 'string' && typeof v.body !== 'string') return false
  } else if (typeof v.text !== 'string') {
    return false
  }
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
  dismissCoachmark: () => {
    ipcRenderer.send('comfy-titlecoachmark:dismiss')
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleTooltip', bridge)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleTooltip = bridge
}
