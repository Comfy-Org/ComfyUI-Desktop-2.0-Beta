/**
 * Regression tests for `showModelFolderRelaunchPage`.
 *
 * Issue #449: After PR #414 split the comfy window into a parent BrowserWindow
 * plus a child WebContentsView, the splash page was being loaded into the
 * parent's webContents, which is hidden behind the views. The signature must
 * therefore accept a WebContents (the comfyView's), not a BrowserWindow, so
 * the splash actually paints on the visible view.
 */

import { describe, it, expect, vi } from 'vitest'
import * as i18n from './i18n'
import { showModelFolderRelaunchPage } from './relaunchPage'
import { SPLASH_DARK, SPLASH_LIGHT } from './theme'

i18n.init('en')

interface FakeWebContents {
  stop: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
}

function createFakeWebContents(): FakeWebContents {
  return {
    stop: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
  }
}

describe('showModelFolderRelaunchPage', () => {
  it('targets the supplied WebContents (not the parent BrowserWindow)', async () => {
    const wc = createFakeWebContents()
    await showModelFolderRelaunchPage(wc as unknown as Electron.WebContents)
    expect(wc.stop).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    const loadedUrl = wc.loadURL.mock.calls[0]![0] as string
    expect(loadedUrl.startsWith('data:text/html')).toBe(true)
  })

  it('embeds the dark theme bg/fg colors when SPLASH_DARK is used', async () => {
    const wc = createFakeWebContents()
    await showModelFolderRelaunchPage(wc as unknown as Electron.WebContents, SPLASH_DARK)
    const loadedUrl = decodeURIComponent(wc.loadURL.mock.calls[0]![0] as string)
    expect(loadedUrl).toContain(SPLASH_DARK.bg)
    expect(loadedUrl).toContain(SPLASH_DARK.fg)
  })

  it('embeds the light theme bg/fg colors when SPLASH_LIGHT is used', async () => {
    const wc = createFakeWebContents()
    await showModelFolderRelaunchPage(wc as unknown as Electron.WebContents, SPLASH_LIGHT)
    const loadedUrl = decodeURIComponent(wc.loadURL.mock.calls[0]![0] as string)
    expect(loadedUrl).toContain(SPLASH_LIGHT.bg)
    expect(loadedUrl).toContain(SPLASH_LIGHT.fg)
  })

  it('stops loading before navigating to the splash data URL', async () => {
    const wc = createFakeWebContents()
    const order: string[] = []
    wc.stop.mockImplementation(() => order.push('stop'))
    wc.loadURL.mockImplementation(async () => { order.push('loadURL') })
    await showModelFolderRelaunchPage(wc as unknown as Electron.WebContents)
    expect(order).toEqual(['stop', 'loadURL'])
  })
})
