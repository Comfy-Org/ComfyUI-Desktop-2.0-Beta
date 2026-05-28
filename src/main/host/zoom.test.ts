import { describe, expect, it } from 'vitest'

import { nextZoomLevel, ZOOM_LEVEL_MAX, ZOOM_LEVEL_MIN, ZOOM_STEP } from './zoom'

describe('nextZoomLevel — Ctrl/Cmd +/-/0 zoom (issue #698)', () => {
  it('zooms IN symmetrically from a zoomed-out level (the regression)', () => {
    // Stuck zoomed-out at -2 after restart; pressing "=" / "+" must climb
    // back up the same step it shrank by. Driving off the tracked level
    // (not a stale getZoomLevel) is what makes this recover.
    expect(nextZoomLevel('=', -2)).toBe(-2 + ZOOM_STEP)
    expect(nextZoomLevel('+', -2)).toBe(-2 + ZOOM_STEP)
  })

  it('zooms OUT by the same step', () => {
    expect(nextZoomLevel('-', 1)).toBe(1 - ZOOM_STEP)
  })

  it('in and out are exact inverses around any level', () => {
    const level = 1.5
    expect(nextZoomLevel('-', nextZoomLevel('=', level))).toBe(level)
  })

  it('reset key returns to 1x (level 0) from either direction', () => {
    expect(nextZoomLevel('0', 3)).toBe(0)
    expect(nextZoomLevel('0', -3)).toBe(0)
  })

  it('clamps to the recoverable range so zoom never strands the view', () => {
    expect(nextZoomLevel('=', ZOOM_LEVEL_MAX)).toBe(ZOOM_LEVEL_MAX)
    expect(nextZoomLevel('-', ZOOM_LEVEL_MIN)).toBe(ZOOM_LEVEL_MIN)
    // From the clamped-out extreme, zooming back in always makes progress.
    expect(nextZoomLevel('=', ZOOM_LEVEL_MIN)).toBe(ZOOM_LEVEL_MIN + ZOOM_STEP)
  })
})
