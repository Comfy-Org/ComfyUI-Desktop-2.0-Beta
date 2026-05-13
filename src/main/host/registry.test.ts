import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// shared.ts imports electron at module load (pulled in transitively by registry.ts).
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

import { _runningSessions } from '../lib/ipc/shared'
import {
  comfyWindows,
  computeBodyMode,
  findPreferredHostByVisibility,
  getEntryByInstallationId,
  indexInstallationId,
  nextWindowKey,
  pendingAttachClaims,
  registerHostEntry,
  unregisterHostEntry,
  type ComfyWindowEntry,
} from './registry'

interface FakeWindow {
  destroyed: boolean
  minimized: boolean
  isDestroyed: () => boolean
  isMinimized: () => boolean
}

function makeWindow(opts: { destroyed?: boolean; minimized?: boolean } = {}): FakeWindow {
  const win: FakeWindow = {
    destroyed: opts.destroyed ?? false,
    minimized: opts.minimized ?? false,
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
  }
  return win
}

function makeEntry(opts: {
  installationId?: string | null
  activePanel?: ComfyWindowEntry['activePanel']
  destroyed?: boolean
  minimized?: boolean
  titleBarWebContents?: unknown
}): ComfyWindowEntry {
  const window = makeWindow({ destroyed: opts.destroyed, minimized: opts.minimized })
  return {
    windowKey: nextWindowKey(),
    window: window as unknown as ComfyWindowEntry['window'],
    comfyView: {} as ComfyWindowEntry['comfyView'],
    titleBarView: {
      webContents: opts.titleBarWebContents ?? {},
    } as unknown as ComfyWindowEntry['titleBarView'],
    panelView: null,
    activePanel: opts.activePanel ?? 'comfy',
    lastTheme: { bg: '#000', text: '#fff' },
    layoutViews: () => {},
    comfyUrl: '',
    installationId: opts.installationId ?? null,
    constructedPartition: null,
    firstUseMode: 'none',
    titleBarText: '',
    sourceCategory: null,
    _installCleanup: null,
    detachInstall: () => {},
  }
}

beforeEach(() => {
  comfyWindows.clear()
  pendingAttachClaims.clear()
  _runningSessions.clear()
})

afterEach(() => {
  comfyWindows.clear()
  pendingAttachClaims.clear()
  _runningSessions.clear()
})

describe('nextWindowKey', () => {
  it('returns sequential, strictly-increasing positive integers', () => {
    const a = nextWindowKey()
    const b = nextWindowKey()
    const c = nextWindowKey()
    expect(a).toBeGreaterThan(0)
    expect(b).toBe(a + 1)
    expect(c).toBe(b + 1)
  })

  it('does not collide across many calls', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 100; i++) {
      const key = nextWindowKey()
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })
})

describe('computeBodyMode', () => {
  it('routes the comfy pill to chooser for install-less hosts', () => {
    const entry = makeEntry({ installationId: null, activePanel: 'comfy' })
    expect(computeBodyMode(entry)).toBe('chooser')
  })

  it('passes non-comfy panels through for install-less hosts', () => {
    const entry = makeEntry({ installationId: null, activePanel: 'settings' })
    expect(computeBodyMode(entry)).toBe('settings')
  })

  it('routes the comfy pill to comfy when the install session is running', () => {
    const entry = makeEntry({ installationId: 'inst-A', activePanel: 'comfy' })
    _runningSessions.set('inst-A', {} as never)
    expect(computeBodyMode(entry)).toBe('comfy')
  })

  it('routes the comfy pill to lifecycle when the install session is not running', () => {
    const entry = makeEntry({ installationId: 'inst-A', activePanel: 'comfy' })
    expect(computeBodyMode(entry)).toBe('comfy-lifecycle')
  })

  it('passes non-comfy panels through for install-backed hosts', () => {
    const entry = makeEntry({ installationId: 'inst-A', activePanel: 'new-install' })
    expect(computeBodyMode(entry)).toBe('new-install')
  })
})

describe('pendingAttachClaims', () => {
  it('round-trips set / get / delete by installation id', () => {
    pendingAttachClaims.set('inst-A', 7)
    pendingAttachClaims.set('inst-B', 9)
    expect(pendingAttachClaims.get('inst-A')).toBe(7)
    expect(pendingAttachClaims.get('inst-B')).toBe(9)
    pendingAttachClaims.delete('inst-A')
    expect(pendingAttachClaims.has('inst-A')).toBe(false)
    expect(pendingAttachClaims.get('inst-B')).toBe(9)
  })

  it('overwrites a prior claim for the same installation id', () => {
    pendingAttachClaims.set('inst-A', 1)
    pendingAttachClaims.set('inst-A', 42)
    expect(pendingAttachClaims.get('inst-A')).toBe(42)
  })
})

describe('register/unregister + getEntryByInstallationId', () => {
  it('round-trips an install-backed entry through the secondary index', () => {
    const entry = makeEntry({ installationId: 'inst-A' })
    registerHostEntry(entry)
    expect(getEntryByInstallationId('inst-A')).toBe(entry)
    unregisterHostEntry(entry)
    expect(getEntryByInstallationId('inst-A')).toBeUndefined()
  })

  it('does not index install-less entries', () => {
    const entry = makeEntry({ installationId: null })
    registerHostEntry(entry)
    expect(getEntryByInstallationId('inst-A')).toBeUndefined()
  })

  it('survives a re-index when a new entry takes over the installation id', () => {
    const first = makeEntry({ installationId: 'inst-A' })
    registerHostEntry(first)
    const second = makeEntry({ installationId: null })
    registerHostEntry(second)
    second.installationId = 'inst-A'
    indexInstallationId('inst-A', second.windowKey)
    expect(getEntryByInstallationId('inst-A')).toBe(second)
    // Unregistering the original entry must not blow away the new owner's
    // secondary-index pointer.
    unregisterHostEntry(first)
    expect(getEntryByInstallationId('inst-A')).toBe(second)
  })
})

describe('findPreferredHostByVisibility', () => {
  it('returns null when nothing matches the predicate', () => {
    registerHostEntry(makeEntry({ installationId: 'inst-A' }))
    expect(findPreferredHostByVisibility(() => false)).toBeNull()
  })

  it('skips destroyed entries', () => {
    const dead = makeEntry({ installationId: null, destroyed: true })
    registerHostEntry(dead)
    expect(findPreferredHostByVisibility(() => true)).toBeNull()
  })

  it('prefers a visible match over an earlier minimised one', () => {
    const minimised = makeEntry({ installationId: null, minimized: true })
    const visible = makeEntry({ installationId: null })
    registerHostEntry(minimised)
    registerHostEntry(visible)
    expect(findPreferredHostByVisibility(() => true)).toBe(visible)
  })

  it('falls back to the first minimised match when none are visible', () => {
    const earlier = makeEntry({ installationId: null, minimized: true })
    const later = makeEntry({ installationId: null, minimized: true })
    registerHostEntry(earlier)
    registerHostEntry(later)
    expect(findPreferredHostByVisibility(() => true)).toBe(earlier)
  })

  it('returns the first visible match in insertion order', () => {
    const a = makeEntry({ installationId: null })
    const b = makeEntry({ installationId: null })
    registerHostEntry(a)
    registerHostEntry(b)
    expect(findPreferredHostByVisibility(() => true)).toBe(a)
  })

  it('honours the predicate so install-less and install-backed buckets stay separate', () => {
    const install = makeEntry({ installationId: 'inst-A' })
    const chooser = makeEntry({ installationId: null })
    registerHostEntry(install)
    registerHostEntry(chooser)
    expect(findPreferredHostByVisibility((e) => e.installationId === null)).toBe(chooser)
    expect(findPreferredHostByVisibility((e) => e.installationId !== null)).toBe(install)
  })
})
