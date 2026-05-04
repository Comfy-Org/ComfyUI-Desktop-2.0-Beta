import { afterEach, describe, expect, it, vi } from 'vitest'

// Stub the parts of electron that shared.ts touches at module load time.
// We only test the broadcast registry — none of the heavyweight session/lifecycle
// helpers — so an empty BrowserWindow.getAllWindows is enough.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}))

import {
  _broadcastToRenderer,
  _registerExtraBroadcastTarget,
  _unregisterExtraBroadcastTarget,
} from './shared'

interface FakeWebContents {
  isDestroyed: () => boolean
  send: ReturnType<typeof vi.fn>
  // Subset of the Electron type used by the registry.
  once: (event: string, cb: () => void) => void
  // Populated by tests that exercise the destroyed listener.
  __destroy?: () => void
}

function makeFakeWc(opts: { destroyed?: boolean } = {}): FakeWebContents {
  const wc: FakeWebContents = {
    isDestroyed: () => !!opts.destroyed,
    send: vi.fn(),
    once: (event, cb) => {
      if (event === 'destroyed') wc.__destroy = cb
    },
  }
  return wc
}

afterEach(() => {
  // Best-effort cleanup of any leftover registered targets across tests.
})

describe('_broadcastToRenderer extra target registry', () => {
  it('forwards broadcasts to a registered WebContents', () => {
    const wc = makeFakeWc()
    _registerExtraBroadcastTarget(wc as unknown as Electron.WebContents)
    _broadcastToRenderer('settings-changed', { key: 'theme' })
    expect(wc.send).toHaveBeenCalledWith('settings-changed', { key: 'theme' })
    _unregisterExtraBroadcastTarget(wc as unknown as Electron.WebContents)
  })

  it('does not forward to destroyed WebContents', () => {
    const wc = makeFakeWc({ destroyed: true })
    _registerExtraBroadcastTarget(wc as unknown as Electron.WebContents)
    _broadcastToRenderer('settings-changed', { key: 'theme' })
    expect(wc.send).not.toHaveBeenCalled()
    _unregisterExtraBroadcastTarget(wc as unknown as Electron.WebContents)
  })

  it('removes targets that fire their destroyed event', () => {
    const wc = makeFakeWc()
    _registerExtraBroadcastTarget(wc as unknown as Electron.WebContents)
    expect(typeof wc.__destroy).toBe('function')

    wc.__destroy!()
    _broadcastToRenderer('settings-changed', { key: 'language' })
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('explicit unregister stops further deliveries', () => {
    const wc = makeFakeWc()
    _registerExtraBroadcastTarget(wc as unknown as Electron.WebContents)
    _unregisterExtraBroadcastTarget(wc as unknown as Electron.WebContents)
    _broadcastToRenderer('settings-changed', { key: 'theme' })
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('handles multiple registered targets independently', () => {
    const a = makeFakeWc()
    const b = makeFakeWc()
    _registerExtraBroadcastTarget(a as unknown as Electron.WebContents)
    _registerExtraBroadcastTarget(b as unknown as Electron.WebContents)
    _broadcastToRenderer('panel-switch', { panel: 'install-settings' })
    expect(a.send).toHaveBeenCalledWith('panel-switch', { panel: 'install-settings' })
    expect(b.send).toHaveBeenCalledWith('panel-switch', { panel: 'install-settings' })
    _unregisterExtraBroadcastTarget(a as unknown as Electron.WebContents)
    _unregisterExtraBroadcastTarget(b as unknown as Electron.WebContents)
  })
})
