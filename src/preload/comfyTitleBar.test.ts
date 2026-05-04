import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// Tests for the static HTML loaded into the title-bar WebContentsView.
// Lives next to its preload because they form one unit (preload exposes the
// bridge that the HTML's inline script wires up).
const html = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'resources', 'comfyTitleBar.html'),
  'utf-8',
)

describe('comfyTitleBar.html', () => {
  it('has a button for each panel key', () => {
    for (const panel of ['comfy', 'install-settings', 'launcher-settings']) {
      expect(html).toContain(`data-panel="${panel}"`)
    }
  })

  it('locks down its CSP', () => {
    expect(html).toMatch(/Content-Security-Policy/)
    expect(html).toMatch(/default-src 'none'/)
    expect(html).toMatch(/script-src 'self'/)
  })

  it('listens to all three bridge channels', () => {
    expect(html).toContain('bridge.onPanelChanged')
    expect(html).toContain('bridge.onTitleChanged')
    expect(html).toContain('bridge.onThemeChanged')
  })

  it('calls bridge.ready() so main can push initial state', () => {
    expect(html).toContain('bridge.ready()')
  })

  it('reserves padding for traffic lights on macOS', () => {
    expect(html).toContain('is-mac')
    expect(html).toMatch(/padding-left:\s*78px/)
  })
})
