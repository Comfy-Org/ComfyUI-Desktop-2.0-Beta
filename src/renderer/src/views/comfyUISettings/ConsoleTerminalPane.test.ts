import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import { TID } from '../../../../shared/testIds'
import type { TerminalRestore } from '../../types/ipc'
import ConsoleTerminalPane from './ConsoleTerminalPane.vue'

// The PTY lives in main; this pane is a thin xterm view. We mock xterm so the
// tests assert the wiring (subscribe on mount, exit banner + restart) rather
// than terminal rendering, which needs a real canvas.

const fakeTerminal = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  resize: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn(),
  element: {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  },
  cols: 80,
  rows: 30
}

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function (this: unknown) {
    return fakeTerminal
  })
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: unknown) {
    return { fit: vi.fn(), proposeDimensions: vi.fn() }
  })
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const messages = {
  en: {
    console: {
      sessionEnded: 'Console session ended',
      restartSession: 'Restart console'
    }
  }
} as const

function createTestI18n() {
  return createI18n({ legacy: false, locale: 'en', messages })
}

let exitCallbacks: Array<(data: { installationId: string }) => void> = []
let outputCallbacks: Array<
  (data: { installationId: string; data: string }) => void
> = []

function makeRestore(overrides: Partial<TerminalRestore> = {}): TerminalRestore {
  return { buffer: [], size: { cols: 80, rows: 30 }, exited: false, ...overrides }
}

function setupApi(subscribeRestore: TerminalRestore = makeRestore()): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    terminalSubscribe: vi.fn().mockResolvedValue(subscribeRestore),
    terminalUnsubscribe: vi.fn().mockResolvedValue(undefined),
    terminalWrite: vi.fn().mockResolvedValue(undefined),
    terminalResize: vi.fn().mockResolvedValue(undefined),
    terminalRestart: vi.fn().mockResolvedValue(makeRestore()),
    onTerminalOutput: vi.fn(
      (cb: (data: { installationId: string; data: string }) => void) => {
        outputCallbacks.push(cb)
        return () => {}
      }
    ),
    onTerminalExited: vi.fn((cb: (data: { installationId: string }) => void) => {
      exitCallbacks.push(cb)
      return () => {}
    })
  }
}

function mountPane(): VueWrapper {
  return mount(ConsoleTerminalPane, {
    props: { installationId: 'install-A' },
    global: { plugins: [createTestI18n()] }
  }) as VueWrapper
}

describe('comfyUISettings/ConsoleTerminalPane', () => {
  beforeEach(() => {
    exitCallbacks = []
    outputCallbacks = []
    vi.clearAllMocks()
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
    setupApi()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('subscribes to the install console on mount', async () => {
    const w = mountPane()
    await flushPromises()
    expect(window.api.terminalSubscribe).toHaveBeenCalledWith('install-A')
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(false)
  })

  it('shows the restart banner on exit and respawns on click', async () => {
    const w = mountPane()
    await flushPromises()

    exitCallbacks.forEach((cb) => cb({ installationId: 'install-A' }))
    await flushPromises()
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(true)

    await w.find(`[data-testid="${TID.consoleRestart}"]`).trigger('click')
    await flushPromises()
    expect(window.api.terminalRestart).toHaveBeenCalledWith('install-A')
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(false)
  })

  it('clears the session-ended banner when output resumes', async () => {
    const w = mountPane()
    await flushPromises()

    exitCallbacks.forEach((cb) => cb({ installationId: 'install-A' }))
    await flushPromises()
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(true)

    outputCallbacks.forEach((cb) =>
      cb({ installationId: 'install-A', data: 'fresh prompt' })
    )
    await flushPromises()
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(false)
  })

  it('re-asserts its size to the shared PTY on focus even when local dims are unchanged', async () => {
    const w = mountPane()
    await flushPromises()

    const host = w.find(`[data-testid="${TID.consoleTerminal}"]`)
      .element as HTMLElement
    Object.defineProperty(host, 'offsetParent', {
      value: document.body,
      configurable: true
    })
    vi.mocked(window.api.terminalResize).mockClear()

    const focusHandler = fakeTerminal.element.addEventListener.mock.calls.find(
      ([event]) => event === 'focusin'
    )?.[1] as () => void
    focusHandler()

    expect(window.api.terminalResize).toHaveBeenCalledWith('install-A', 80, 30)
  })

  it('ignores exit events for other installations', async () => {
    const w = mountPane()
    await flushPromises()

    exitCallbacks.forEach((cb) => cb({ installationId: 'other-install' }))
    await flushPromises()
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(false)
  })

  it('shows the banner immediately when restored session was already exited', async () => {
    setupApi(makeRestore({ exited: true }))
    const w = mountPane()
    await flushPromises()
    expect(w.find(`[data-testid="${TID.consoleSessionEnded}"]`).exists()).toBe(true)
  })
})
