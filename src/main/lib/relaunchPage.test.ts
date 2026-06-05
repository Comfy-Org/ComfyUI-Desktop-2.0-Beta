// The splash must target the comfyView's WebContents, not the parent BrowserWindow (hidden behind views).

import { describe, it, expect, vi } from 'vitest'
import * as i18n from './i18n'
import { showSplashPage } from './relaunchPage'
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

describe('showSplashPage', () => {
  it('targets the supplied WebContents (not the parent BrowserWindow)', async () => {
    const wc = createFakeWebContents()
    await showSplashPage(wc as unknown as Electron.WebContents)
    expect(wc.stop).toHaveBeenCalledTimes(1)
    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    const loadedUrl = wc.loadURL.mock.calls[0]![0] as string
    expect(loadedUrl.startsWith('data:text/html')).toBe(true)
  })

  it('embeds the dark theme bg/fg colors when SPLASH_DARK is used', async () => {
    const wc = createFakeWebContents()
    await showSplashPage(wc as unknown as Electron.WebContents, SPLASH_DARK)
    const loadedUrl = decodeURIComponent(wc.loadURL.mock.calls[0]![0] as string)
    expect(loadedUrl).toContain(SPLASH_DARK.bg)
    expect(loadedUrl).toContain(SPLASH_DARK.fg)
  })

  it('embeds the light theme bg/fg colors when SPLASH_LIGHT is used', async () => {
    const wc = createFakeWebContents()
    await showSplashPage(wc as unknown as Electron.WebContents, SPLASH_LIGHT)
    const loadedUrl = decodeURIComponent(wc.loadURL.mock.calls[0]![0] as string)
    expect(loadedUrl).toContain(SPLASH_LIGHT.bg)
    expect(loadedUrl).toContain(SPLASH_LIGHT.fg)
  })

  it('uses the supplied copy override in the splash markup', async () => {
    const wc = createFakeWebContents()
    await showSplashPage(wc as unknown as Electron.WebContents, SPLASH_DARK, {
      title: 'Starting ComfyUI',
      desc: 'Launching your ComfyUI instance…',
    })
    const loadedUrl = decodeURIComponent(wc.loadURL.mock.calls[0]![0] as string)
    expect(loadedUrl).toContain('Starting ComfyUI')
    expect(loadedUrl).toContain('Launching your ComfyUI instance…')
    expect(loadedUrl).not.toContain('New model folders')
  })

  it('stops loading before navigating to the splash data URL', async () => {
    const wc = createFakeWebContents()
    const order: string[] = []
    wc.stop.mockImplementation(() => order.push('stop'))
    wc.loadURL.mockImplementation(async () => { order.push('loadURL') })
    await showSplashPage(wc as unknown as Electron.WebContents)
    expect(order).toEqual(['stop', 'loadURL'])
  })
})
