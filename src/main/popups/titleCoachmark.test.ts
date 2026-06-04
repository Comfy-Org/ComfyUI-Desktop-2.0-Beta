import { describe, expect, it, vi } from 'vitest'

// Module loads electron at import even though the pure helpers under test never use it.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en'
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  WebContentsView: class {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false }
}))

// Stub embeddedPopupView so its electron usage doesn't load.
vi.mock('./embeddedPopupView', () => ({ EmbeddedPopupView: class {} }))

import {
  buildCoachmarkConfig,
  positionCoachmark,
  COACHMARK_SHADOW_GUTTER,
  COACHMARK_VERTICAL_GAP
} from './titleCoachmark'

describe('buildCoachmarkConfig', () => {
  it('stamps the coachmark variant and carries title + body + dismiss copy', () => {
    const cfg = buildCoachmarkConfig({
      title: 'Switch & manage instances',
      body: 'Click here to switch instances.',
      dismissLabel: 'Got it',
      token: 'cm-1'
    })
    expect(cfg.variant).toBe('coachmark')
    expect(cfg.title).toBe('Switch & manage instances')
    expect(cfg.body).toBe('Click here to switch instances.')
    expect(cfg.dismissLabel).toBe('Got it')
    expect(cfg.configToken).toBe('cm-1')
    expect(cfg.theme.accent).toMatch(/^#/)
  })
})

describe('positionCoachmark', () => {
  const parentBounds = { width: 1200, height: 800 }

  it('centers the card under the pill and offsets below it', () => {
    const bounds = positionCoachmark({
      anchor: { leftX: 500, rightX: 700, bottomY: 36 },
      bubble: { width: 260, height: 72 },
      parentBounds
    })
    const pillCenter = 600
    const viewWidth = 260 + COACHMARK_SHADOW_GUTTER * 2
    expect(bounds.width).toBe(viewWidth)
    expect(bounds.x).toBe(Math.round(pillCenter - viewWidth / 2))
    expect(bounds.y).toBe(Math.round(36 + COACHMARK_VERTICAL_GAP - COACHMARK_SHADOW_GUTTER / 2))
  })

  it('clamps to the parent content bounds so it never goes off-screen left', () => {
    const bounds = positionCoachmark({
      anchor: { leftX: 0, rightX: 20, bottomY: 36 },
      bubble: { width: 260, height: 72 },
      parentBounds
    })
    expect(bounds.x).toBeGreaterThanOrEqual(0)
  })

  it('clamps to the parent content bounds so it never overflows right', () => {
    const bounds = positionCoachmark({
      anchor: { leftX: 1180, rightX: 1200, bottomY: 36 },
      bubble: { width: 260, height: 72 },
      parentBounds
    })
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(parentBounds.width)
  })
})
