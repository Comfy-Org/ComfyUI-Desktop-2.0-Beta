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

import { _runningSessions, _stoppingInstallationIds } from '../lib/ipc/shared'
import {
  _resetAttachClaimsForTest,
  claimAttachHost,
  comfyWindows,
  computeBodyMode,
  consumeAttachClaim,
  dropAttachClaimsForWindow,
  dropInstallationIndex,
  findPreferredHostByVisibility,
  getEntryByInstallationId,
  hostInstallEvents,
  indexInstallationId,
  nextWindowKey,
  forceRevealHostWindow,
  hasRunningSessionForEntry,
  raiseAllHostWindows,
  registerHostEntry,
  setHostFactories,
  setLastFocusedInstallationId,
  shouldConfirmKillForEntry,
  unregisterHostEntry,
  type ComfyWindowEntry,
} from './registry'

interface FakeWindow {
  destroyed: boolean
  minimized: boolean
  isDestroyed: () => boolean
  isMinimized: () => boolean
  /** show()/focus()/restore() calls, in order, so tests can assert raise behaviour. */
  raised: string[]
  show: () => void
  focus: () => void
  restore: () => void
  setAlwaysOnTop: () => void
}

function makeWindow(opts: { destroyed?: boolean; minimized?: boolean } = {}): FakeWindow {
  const win: FakeWindow = {
    destroyed: opts.destroyed ?? false,
    minimized: opts.minimized ?? false,
    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    raised: [],
    show: () => win.raised.push('show'),
    focus: () => win.raised.push('focus'),
    restore: () => {
      win.minimized = false
      win.raised.push('restore')
    },
    setAlwaysOnTop: () => {},
  }
  return win
}

function makeEntry(opts: {
  installationId?: string | null
  activePanel?: ComfyWindowEntry['activePanel']
  destroyed?: boolean
  minimized?: boolean
  titleBarWebContents?: unknown
  sourceCategory?: ComfyWindowEntry['sourceCategory']
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
    sourceCategory: opts.sourceCategory ?? null,
    previewInstallationId: null,
    coldStartPendingReveal: false,
    _installCleanup: null,
    detachInstall: () => {},
  }
}

beforeEach(() => {
  comfyWindows.clear()
  _resetAttachClaimsForTest()
  _runningSessions.clear()
  _stoppingInstallationIds.clear()
})

afterEach(() => {
  comfyWindows.clear()
  _resetAttachClaimsForTest()
  _runningSessions.clear()
  _stoppingInstallationIds.clear()
  setLastFocusedInstallationId(null)
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
    const entry = makeEntry({ installationId: null, activePanel: 'downloads-v2' })
    expect(computeBodyMode(entry)).toBe('downloads-v2')
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

  it('routes a stopping install to lifecycle even while its session is still running', () => {
    // The session lives until the kill completes; the "Stopping…" panel must
    // show up front so the dying canvas doesn't flash black.
    const entry = makeEntry({ installationId: 'inst-A', activePanel: 'comfy' })
    _runningSessions.set('inst-A', {} as never)
    _stoppingInstallationIds.add('inst-A')
    expect(computeBodyMode(entry)).toBe('comfy-lifecycle')
  })

  it('passes non-comfy panels through for install-backed hosts', () => {
    const entry = makeEntry({ installationId: 'inst-A', activePanel: 'new-install' })
    expect(computeBodyMode(entry)).toBe('new-install')
  })

  // `'progress'` must flip showPanel true so ProgressModal stays visible over a running
  // canvas; otherwise the panel sits at 0x0 behind comfyView and the modal is unreachable.
  it('returns `progress` for install-backed hosts in progress mode, even while the session is running', () => {
    const entry = makeEntry({ installationId: 'inst-A', activePanel: 'progress' })
    _runningSessions.set('inst-A', {} as never)
    expect(computeBodyMode(entry)).toBe('progress')
  })

  it('returns `progress` for install-less hosts in progress mode (cold-spawn chooser case)', () => {
    const entry = makeEntry({ installationId: null, activePanel: 'progress' })
    expect(computeBodyMode(entry)).toBe('progress')
  })
})

describe('shouldConfirmKillForEntry', () => {
  // Rule: "would tearing this down kill a local ComfyUI process?" — yes for install-backed
  // local hosts, no for everything else.
  it('returns true for an install-backed local host', () => {
    const entry = makeEntry({ installationId: 'inst-A', sourceCategory: 'local' })
    expect(shouldConfirmKillForEntry(entry)).toBe(true)
  })

  it('returns false for a cloud/remote-backed host (no local process at risk)', () => {
    expect(
      shouldConfirmKillForEntry(
        makeEntry({ installationId: 'inst-cloud', sourceCategory: 'cloud' }),
      ),
    ).toBe(false)
    expect(
      shouldConfirmKillForEntry(
        makeEntry({ installationId: 'inst-remote', sourceCategory: 'remote' }),
      ),
    ).toBe(false)
  })

  it('returns false for a chooser/install-less host (nothing to kill)', () => {
    expect(shouldConfirmKillForEntry(makeEntry({ installationId: null }))).toBe(false)
  })

  it('returns false for a preview-chooser host that carries a local sourceCategory without an install', () => {
    // attachHostPreview can flash `sourceCategory` onto an install-less host while hovering;
    // no attached install or session means no kill-confirm.
    expect(
      shouldConfirmKillForEntry(
        makeEntry({ installationId: null, sourceCategory: 'local' }),
      ),
    ).toBe(false)
  })

  it('returns false for null/undefined entries', () => {
    expect(shouldConfirmKillForEntry(null)).toBe(false)
    expect(shouldConfirmKillForEntry(undefined)).toBe(false)
  })
})

describe('hasRunningSessionForEntry', () => {
  // Rule: "is this an install-backed window showing a live ComfyUI view?" — true only when
  // the install has a session in `_runningSessions` (local OR cloud/remote). Drives whether
  // the window is a healthy "last active surface" worth restoring on next boot.
  it('returns true for an install-backed host with a running session', () => {
    const entry = makeEntry({ installationId: 'inst-A', sourceCategory: 'local' })
    _runningSessions.set('inst-A', {} as never)
    expect(hasRunningSessionForEntry(entry)).toBe(true)
  })

  it('returns true for a running cloud/remote-backed host', () => {
    _runningSessions.set('inst-cloud', {} as never)
    expect(
      hasRunningSessionForEntry(makeEntry({ installationId: 'inst-cloud', sourceCategory: 'cloud' })),
    ).toBe(true)
  })

  it('returns false for an install-backed host with no running session (stopped/crashed)', () => {
    expect(
      hasRunningSessionForEntry(makeEntry({ installationId: 'inst-A', sourceCategory: 'local' })),
    ).toBe(false)
  })

  it('returns false for a chooser/install-less host', () => {
    expect(hasRunningSessionForEntry(makeEntry({ installationId: null }))).toBe(false)
  })

  it('returns false for null/undefined entries', () => {
    expect(hasRunningSessionForEntry(null)).toBe(false)
    expect(hasRunningSessionForEntry(undefined)).toBe(false)
  })
})

describe('forceRevealHostWindow', () => {
  it('reveals a deferred host regardless of the coldStartPendingReveal flag', () => {
    const entry = makeEntry({ installationId: null })
    entry.coldStartPendingReveal = false // deferred restore leaves the flag off
    registerHostEntry(entry)

    forceRevealHostWindow(entry.windowKey)

    expect(entry.coldStartPendingReveal).toBe(false)
    expect((entry.window as unknown as FakeWindow).raised).toContain('show')
  })

  it('no-ops for a destroyed window', () => {
    const entry = makeEntry({ installationId: null, destroyed: true })
    registerHostEntry(entry)
    forceRevealHostWindow(entry.windowKey)
    expect((entry.window as unknown as FakeWindow).raised).not.toContain('show')
  })

  it('no-ops for an unknown window key', () => {
    expect(() => forceRevealHostWindow(999_999)).not.toThrow()
  })
})

describe('attach-claim helpers', () => {
  it('consumeAttachClaim returns the claimed key and clears the entry', () => {
    claimAttachHost('inst-A', 7)
    claimAttachHost('inst-B', 9)
    expect(consumeAttachClaim('inst-A')).toBe(7)
    // Take-once contract: a second consume is empty so onLaunch can't double-attach.
    expect(consumeAttachClaim('inst-A')).toBeUndefined()
    expect(consumeAttachClaim('inst-B')).toBe(9)
  })

  it('consumeAttachClaim returns undefined when no claim exists', () => {
    expect(consumeAttachClaim('inst-missing')).toBeUndefined()
  })

  it('claimAttachHost overwrites a prior claim for the same id', () => {
    claimAttachHost('inst-A', 1)
    claimAttachHost('inst-A', 42)
    expect(consumeAttachClaim('inst-A')).toBe(42)
  })

  it('dropAttachClaimsForWindow removes only claims targeting that windowKey', () => {
    claimAttachHost('inst-A', 7)
    claimAttachHost('inst-B', 9)
    claimAttachHost('inst-C', 7)
    dropAttachClaimsForWindow(7)
    expect(consumeAttachClaim('inst-A')).toBeUndefined()
    expect(consumeAttachClaim('inst-C')).toBeUndefined()
    expect(consumeAttachClaim('inst-B')).toBe(9)
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
    // Unregistering the original entry must not blow away the new owner's index pointer.
    unregisterHostEntry(first)
    expect(getEntryByInstallationId('inst-A')).toBe(second)
  })
})

describe('hostInstallEvents', () => {
  // Without this event the picker's "Current" pill would only repaint at instance-started
  // time, leaving a Current-less row for the whole launching window.
  let events: string[]
  let listener: () => void
  beforeEach(() => {
    events = []
    listener = () => events.push('changed')
    hostInstallEvents.on('changed', listener)
  })
  afterEach(() => {
    hostInstallEvents.off('changed', listener)
  })

  it('fires on indexInstallationId (attach)', () => {
    indexInstallationId('inst-A', 1)
    expect(events).toEqual(['changed'])
  })

  it('fires on dropInstallationIndex when the index actually shrinks', () => {
    indexInstallationId('inst-A', 1)
    events.length = 0
    dropInstallationIndex('inst-A')
    expect(events).toEqual(['changed'])
  })

  it('does NOT fire on dropInstallationIndex when the id was already absent', () => {
    // No-op drops shouldn't churn picker snapshots.
    dropInstallationIndex('inst-never-indexed')
    expect(events).toEqual([])
  })

  it('fires on registerHostEntry when the entry is install-backed', () => {
    registerHostEntry(makeEntry({ installationId: 'inst-A' }))
    expect(events).toEqual(['changed'])
  })

  it('does NOT fire on registerHostEntry for an install-less (chooser) host', () => {
    // A fresh chooser host has no attached install to surface, so it shouldn't repaint pickers.
    registerHostEntry(makeEntry({ installationId: null }))
    expect(events).toEqual([])
  })

  it('fires on unregisterHostEntry (detach via close handler) for an install-backed host', () => {
    const entry = makeEntry({ installationId: 'inst-A' })
    registerHostEntry(entry)
    events.length = 0
    unregisterHostEntry(entry)
    expect(events).toEqual(['changed'])
  })

  it('does NOT fire on unregisterHostEntry for an install-less host', () => {
    const entry = makeEntry({ installationId: null })
    registerHostEntry(entry)
    unregisterHostEntry(entry)
    expect(events).toEqual([])
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

describe('raiseAllHostWindows', () => {
  function fakeWin(entry: ComfyWindowEntry): FakeWindow {
    return entry.window as unknown as FakeWindow
  }

  it('spawns a fresh chooser host when no live host exists', () => {
    const spawned = makeWindow()
    const createChooser = vi.fn(() => spawned as unknown as ComfyWindowEntry['window'])
    setHostFactories({ createChooser })
    const result = raiseAllHostWindows()
    expect(createChooser).toHaveBeenCalledTimes(1)
    expect(result).toBe(spawned as unknown as ComfyWindowEntry['window'])
  })

  it('raises every live host window to the front', () => {
    const a = makeEntry({ installationId: null })
    const b = makeEntry({ installationId: null })
    const c = makeEntry({ installationId: null })
    registerHostEntry(a)
    registerHostEntry(b)
    registerHostEntry(c)
    raiseAllHostWindows()
    expect(fakeWin(a).raised).toContain('focus')
    expect(fakeWin(b).raised).toContain('focus')
    expect(fakeWin(c).raised).toContain('focus')
  })

  it('skips destroyed entries', () => {
    const live = makeEntry({ installationId: null })
    const dead = makeEntry({ installationId: null, destroyed: true })
    registerHostEntry(live)
    registerHostEntry(dead)
    raiseAllHostWindows()
    expect(fakeWin(live).raised).toContain('focus')
    expect(fakeWin(dead).raised).toEqual([])
  })

  it('leaves the preferred install host frontmost (raised last)', () => {
    const order: string[] = []
    const chooser = makeEntry({ installationId: null })
    const install = makeEntry({ installationId: 'inst-A' })
    fakeWin(chooser).focus = () => order.push('chooser')
    fakeWin(install).focus = () => order.push('install')
    registerHostEntry(chooser)
    registerHostEntry(install)
    const result = raiseAllHostWindows()
    // install-backed beats chooser, so it's focused last (frontmost) and returned.
    expect(order[order.length - 1]).toBe('install')
    expect(result).toBe(install.window)
  })

  it('restores a minimised host before focusing it', () => {
    const min = makeEntry({ installationId: null, minimized: true })
    registerHostEntry(min)
    raiseAllHostWindows()
    expect(fakeWin(min).raised).toContain('restore')
    expect(fakeWin(min).raised).toContain('focus')
  })
})
