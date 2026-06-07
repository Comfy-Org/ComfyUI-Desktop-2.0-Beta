import { afterEach, describe, expect, it, vi } from 'vitest'

import { installPickerSettingsApiShim } from './pickerSettingsApiShim'

// The settings UI runs inside the title-popup WebContents, which has the
// `__comfyTitlePopup` bridge instead of `window.api`. The shim must forward
// every method the settings UI calls — including the interactive console —
// or the Console tab mounts xterm against undefined APIs and wedges the tab
// transition (regression: the whole settings UI appeared to freeze).

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
  delete (window as unknown as { __comfyTitlePopup?: unknown }).__comfyTitlePopup
})

function installBridge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const explicit: Record<string, unknown> = {
    terminalSubscribe: vi.fn().mockResolvedValue({
      buffer: [],
      size: { cols: 80, rows: 30 },
      exited: false
    }),
    terminalUnsubscribe: vi.fn().mockResolvedValue(undefined),
    terminalWrite: vi.fn().mockResolvedValue(undefined),
    terminalResize: vi.fn().mockResolvedValue(undefined),
    terminalRestart: vi.fn().mockResolvedValue({
      buffer: [],
      size: { cols: 80, rows: 30 },
      exited: false
    }),
    onTerminalOutput: vi.fn(() => () => {}),
    onTerminalExited: vi.fn(() => () => {}),
    ...overrides
  }
  // Auto-stub any other mapped bridge method the shim binds, so the test only
  // has to declare the terminal methods it asserts on.
  const bridge = new Proxy(explicit, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn()
      return target[prop]
    },
    has() {
      return true
    }
  })
  ;(window as unknown as { __comfyTitlePopup?: unknown }).__comfyTitlePopup = bridge
  return bridge
}

describe('installPickerSettingsApiShim — terminal forwarding', () => {
  const terminalMethods = [
    'terminalSubscribe',
    'terminalUnsubscribe',
    'terminalWrite',
    'terminalResize',
    'terminalRestart',
    'onTerminalOutput',
    'onTerminalExited'
  ] as const

  it('exposes every terminal method on window.api', () => {
    installBridge()
    installPickerSettingsApiShim()

    const api = (window as unknown as { api: Record<string, unknown> }).api
    for (const method of terminalMethods) {
      expect(typeof api[method]).toBe('function')
    }
  })

  it('forwards terminal calls to the bridge', async () => {
    const bridge = installBridge()
    installPickerSettingsApiShim()

    const api = (window as unknown as {
      api: {
        terminalSubscribe: (id: string) => Promise<unknown>
        terminalWrite: (id: string, data: string) => Promise<void>
        onTerminalOutput: (cb: () => void) => () => void
      }
    }).api

    await api.terminalSubscribe('install-A')
    expect(bridge.terminalSubscribe).toHaveBeenCalledWith('install-A')

    await api.terminalWrite('install-A', 'ls\r')
    expect(bridge.terminalWrite).toHaveBeenCalledWith('install-A', 'ls\r')

    const cb = vi.fn()
    api.onTerminalOutput(cb)
    expect(bridge.onTerminalOutput).toHaveBeenCalledWith(cb)
  })
})
