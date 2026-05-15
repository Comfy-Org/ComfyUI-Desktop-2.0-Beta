import { screen } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'
import fs from 'fs'
import { configDir } from './paths'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

const windowStatePath = (): string => path.join(configDir(), 'window-state.json')
let windowStateCache: Record<string, WindowBounds> | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null

function getWindowStateCache(): Record<string, WindowBounds> {
  if (!windowStateCache) {
    try {
      windowStateCache = JSON.parse(fs.readFileSync(windowStatePath(), 'utf-8'))
    } catch {
      windowStateCache = {}
    }
  }
  return windowStateCache!
}

export async function flushWindowState(): Promise<void> {
  if (!windowStateCache) return
  try {
    const p = windowStatePath()
    await fs.promises.mkdir(path.dirname(p), { recursive: true })
    await fs.promises.writeFile(p, JSON.stringify(windowStateCache, null, 2))
  } catch {}
}

export function saveWindowBounds(installationId: string, window: BrowserWindow): void {
  const state = getWindowStateCache()
  const maximized = window.isMaximized()
  const bounds = window.getBounds()
  state[installationId] = {
    ...(maximized ? (state[installationId] ?? bounds) : bounds),
    maximized,
  }
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushWindowState, 500)
}

export function getSavedBounds(installationId: string): WindowBounds | undefined {
  return getWindowStateCache()[installationId]
}

export function getWindowOptions(
  installationId: string,
): Partial<Electron.BrowserWindowConstructorOptions> {
  const saved = getSavedBounds(installationId)
  if (!saved) return { width: 1280, height: 900 }

  const savedRect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  const display = screen.getDisplayMatching(savedRect)
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea
  const width = Math.min(saved.width, ww)
  const height = Math.min(saved.height, wh)
  const x = Math.max(wx, Math.min(saved.x, wx + ww - width))
  const y = Math.max(wy, Math.min(saved.y, wy + wh - height))
  return { x, y, width, height }
}
