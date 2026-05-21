import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: {},
  WebContentsView: class {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}))

import { _runningSessions } from '../lib/ipc/shared'
import { comfyWindows, nextWindowKey, type ComfyWindowEntry } from './registry'
import { closeAllHostWindows, detachOrphanedInstallHosts, preClearedClose } from './detach'

interface FakeWindow {
  destroyed: boolean
  closed: boolean
  isDestroyed: () => boolean
  close: () => void
}

function makeWindow(opts: { destroyed?: boolean } = {}): FakeWindow {
  const win: FakeWindow = {
    destroyed: opts.destroyed ?? false,
    closed: false,
    isDestroyed: () => win.destroyed,
    close: () => { win.closed = true },
  }
  return win
}

function makeEntry(window: FakeWindow): ComfyWindowEntry {
  return {
    windowKey: nextWindowKey(),
    window: window as unknown as ComfyWindowEntry['window'],
    comfyView: {} as ComfyWindowEntry['comfyView'],
    titleBarView: { webContents: {} } as unknown as ComfyWindowEntry['titleBarView'],
    panelView: null,
    activePanel: 'comfy',
    lastTheme: { bg: '#000', text: '#fff' },
    layoutViews: () => {},
    comfyUrl: '',
    installationId: null,
    constructedPartition: null,
    firstUseMode: 'none',
    titleBarText: '',
    sourceCategory: null,
    previewInstallationId: null,
    coldStartPendingReveal: false,
    _installCleanup: null,
    detachInstall: () => {},
  }
}

beforeEach(() => {
  comfyWindows.clear()
  _runningSessions.clear()
})

afterEach(() => {
  comfyWindows.clear()
  _runningSessions.clear()
})

describe('closeAllHostWindows', () => {
  it('calls close() on every live host window', () => {
    const a = makeWindow()
    const b = makeWindow()
    const c = makeWindow()
    const entryA = makeEntry(a)
    const entryB = makeEntry(b)
    const entryC = makeEntry(c)
    comfyWindows.set(entryA.windowKey, entryA)
    comfyWindows.set(entryB.windowKey, entryB)
    comfyWindows.set(entryC.windowKey, entryC)

    closeAllHostWindows()

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
    expect(c.closed).toBe(true)
  })

  it('skips windows that are already destroyed', () => {
    const live = makeWindow()
    const dead = makeWindow({ destroyed: true })
    const entryLive = makeEntry(live)
    const entryDead = makeEntry(dead)
    comfyWindows.set(entryLive.windowKey, entryLive)
    comfyWindows.set(entryDead.windowKey, entryDead)

    closeAllHostWindows()

    expect(live.closed).toBe(true)
    expect(dead.closed).toBe(false)
  })

  it('is safe to call when no windows are open', () => {
    expect(() => closeAllHostWindows()).not.toThrow()
  })

  it('snapshots the entry list so a synchronous closed-callback delete during iteration does not skip windows', () => {
    const a = makeWindow()
    const b = makeWindow()
    const entryA = makeEntry(a)
    const entryB = makeEntry(b)
    comfyWindows.set(entryA.windowKey, entryA)
    comfyWindows.set(entryB.windowKey, entryB)
    // Simulate a synchronous closed handler that deletes from the map
    // mid-iteration. Without the Array.from(...) snapshot in the impl,
    // the second entry would be skipped.
    a.close = () => {
      a.closed = true
      comfyWindows.delete(entryA.windowKey)
    }
    b.close = () => {
      b.closed = true
      comfyWindows.delete(entryB.windowKey)
    }

    closeAllHostWindows()

    expect(a.closed).toBe(true)
    expect(b.closed).toBe(true)
  })
})

describe('detachOrphanedInstallHosts', () => {
  function makeInstallEntry(installationId: string | null): ComfyWindowEntry {
    const win = makeWindow()
    const entry = makeEntry(win)
    entry.installationId = installationId
    entry.detachInstall = vi.fn()
    return entry
  }

  it('detaches install-backed entries whose install id is no longer in the registry', () => {
    const live = makeInstallEntry('inst-A')
    const orphan = makeInstallEntry('inst-B')
    comfyWindows.set(live.windowKey, live)
    comfyWindows.set(orphan.windowKey, orphan)

    detachOrphanedInstallHosts(new Set(['inst-A']))

    expect(live.detachInstall).not.toHaveBeenCalled()
    expect(orphan.detachInstall).toHaveBeenCalledTimes(1)
  })

  it('leaves chooser hosts (no installationId) untouched', () => {
    const chooser = makeInstallEntry(null)
    comfyWindows.set(chooser.windowKey, chooser)

    detachOrphanedInstallHosts(new Set())

    expect(chooser.detachInstall).not.toHaveBeenCalled()
  })

  it('skips destroyed windows', () => {
    const dead = makeInstallEntry('inst-X')
    ;(dead.window as unknown as FakeWindow).destroyed = true
    comfyWindows.set(dead.windowKey, dead)

    detachOrphanedInstallHosts(new Set())

    expect(dead.detachInstall).not.toHaveBeenCalled()
  })

  it('is safe when comfyWindows is empty', () => {
    expect(() => detachOrphanedInstallHosts(new Set(['inst-A']))).not.toThrow()
  })
})

describe('preClearedClose', () => {
  it('reports membership for added windows and ignores unknowns', () => {
    const a = makeWindow()
    const b = makeWindow()
    expect(preClearedClose.has(a as unknown as Electron.BrowserWindow)).toBe(false)
    preClearedClose.add(a as unknown as Electron.BrowserWindow)
    expect(preClearedClose.has(a as unknown as Electron.BrowserWindow)).toBe(true)
    expect(preClearedClose.has(b as unknown as Electron.BrowserWindow)).toBe(false)
  })

  it('drops membership on delete()', () => {
    const a = makeWindow()
    preClearedClose.add(a as unknown as Electron.BrowserWindow)
    expect(preClearedClose.delete(a as unknown as Electron.BrowserWindow)).toBe(true)
    expect(preClearedClose.has(a as unknown as Electron.BrowserWindow)).toBe(false)
  })
})
