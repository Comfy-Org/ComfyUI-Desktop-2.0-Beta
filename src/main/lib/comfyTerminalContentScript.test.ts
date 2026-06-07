import { describe, expect, it } from 'vitest'
import { getComfyTerminalContentScript } from './comfyTerminalContentScript'

describe('getComfyTerminalContentScript', () => {
  const script = getComfyTerminalContentScript()

  it('returns a syntactically valid, self-contained IIFE', () => {
    expect(script.startsWith('(function () {')).toBe(true)
    // Throws on a syntax error in the assembled string (escaping bugs, etc.).
    expect(() => new Function(script)).not.toThrow()
  })

  it('bails when the desktop terminal bridge is absent', () => {
    expect(script).toContain('!window.__comfyDesktop2.Terminal')
  })

  it('guards against double injection', () => {
    expect(script).toContain('window.__comfyDesktopTerminalStopgap')
  })

  it('inlines the xterm UMD build and its fit addon', () => {
    expect(script).toContain('__xt.exports')
    expect(script).toContain('__fit.exports')
    expect(script).toContain('var XTerm =')
    expect(script).toContain('var FitAddon =')
  })

  it('injects the xterm stylesheet exactly once via a stable id', () => {
    expect(script).toContain('__comfyDesktopXtermCss')
    expect(script).toContain('.xterm')
  })

  it('registers a custom bottom-panel tab through the extension API', () => {
    expect(script).toContain('registerExtension')
    expect(script).toContain('bottomPanelTabs')
    expect(script).toContain(`type: 'custom'`)
    expect(script).toContain(`id: 'command-terminal'`)
    expect(script).toContain(`title: 'Terminal'`)
  })

  it('uses the shared desktop terminal transport', () => {
    for (const member of ['subscribe', 'write', 'resize', 'restart', 'onOutput', 'onExited']) {
      expect(script).toContain(member)
    }
  })

  it('memoizes the assembled script', () => {
    expect(getComfyTerminalContentScript()).toBe(script)
  })
})
