import { describe, expect, it, vi } from 'vitest'

// shared.ts (via registry.ts) loads electron at import, so mock it first.
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
  WebContentsView: class {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}))

import {
  buildInstancePickerSnapshot,
  resolvePickerSelectedInstallId,
  buildTitlePopupMenuItems,
  computePopupHeight,
  decideFlowMenuItemTarget,
  isFlowMenuItemId,
  type FlowMenuItemId,
  type InstancePickerInstall,
} from './titlePopup'
import { nextWindowKey, type ComfyWindowEntry } from '../host/registry'

interface FakeComfyWebContents {
  destroyed: boolean
  zoomLevel: number
  isDestroyed: () => boolean
  getZoomLevel: () => number
}

function makeEntry(opts: {
  installationId?: string | null
  activePanel?: ComfyWindowEntry['activePanel']
  firstUseMode?: ComfyWindowEntry['firstUseMode']
  comfyDestroyed?: boolean
  zoomLevel?: number
} = {}): ComfyWindowEntry {
  const wc: FakeComfyWebContents = {
    destroyed: opts.comfyDestroyed ?? false,
    zoomLevel: opts.zoomLevel ?? 0,
    isDestroyed: () => wc.destroyed,
    getZoomLevel: () => wc.zoomLevel,
  }
  return {
    windowKey: nextWindowKey(),
    window: {} as ComfyWindowEntry['window'],
    comfyView: {
      webContents: wc as unknown,
    } as unknown as ComfyWindowEntry['comfyView'],
    titleBarView: { webContents: {} } as unknown as ComfyWindowEntry['titleBarView'],
    panelView: null,
    activePanel: opts.activePanel ?? 'comfy',
    lastTheme: { bg: '#000', text: '#fff' },
    layoutViews: () => {},
    comfyUrl: '',
    installationId: opts.installationId ?? null,
    constructedPartition: null,
    firstUseMode: opts.firstUseMode ?? 'none',
    titleBarText: '',
    sourceCategory: null,
    previewInstallationId: null,
    coldStartPendingReveal: false,
    _installCleanup: null,
    detachInstall: () => {},
  }
}

describe('computePopupHeight', () => {
  it('counts items at 28px and separators at 9px plus the 10px chrome budget', () => {
    // 1 item + 1 sep + 1 item + 1 sep + 1 item = 28+9+28+9+28 = 102 + 10 chrome = 112
    const h = computePopupHeight([
      { id: 'a', label: 'A' },
      { kind: 'separator' },
      { id: 'b', label: 'B' },
      { kind: 'separator' },
      { id: 'c', label: 'C' },
    ])
    expect(h).toBe(112)
  })

  it('returns chrome-only height for an empty item list', () => {
    expect(computePopupHeight([])).toBe(10)
  })

  it('handles a single item', () => {
    expect(computePopupHeight([{ id: 'a', label: 'A' }])).toBe(38)
  })

  it('handles a single separator', () => {
    expect(computePopupHeight([{ kind: 'separator' }])).toBe(19)
  })
})

describe('buildTitlePopupMenuItems', () => {
  it('returns only Skip Onboarding during post-consent first-use', () => {
    const entry = makeEntry({ firstUseMode: 'post-consent' })
    const items = buildTitlePopupMenuItems(entry)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'skip-onboarding' })
  })

  it('includes install-creation entries on a chooser host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids).toContain('new-install')
    expect(ids).toContain('track')
    expect(ids).toContain('load-snapshot')
    expect(ids).not.toContain('return-to-dashboard')
  })

  it('includes install-creation entries on an install-backed host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: 'inst-1' }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids).toContain('new-install')
    expect(ids).toContain('track')
    expect(ids).toContain('load-snapshot')
  })

  it('chooser host includes New Window, Settings, Send Feedback, Close Window, and Quit Desktop', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids).toContain('new-window')
    expect(ids).toContain('settings')
    expect(ids).toContain('feedback')
    expect(ids).toContain('exit-window')
    expect(ids).toContain('close-all-windows')
    const quit = items.find((i) => i.id === 'close-all-windows')
    expect(quit?.label).toBe('Quit Desktop')
  })

  it('chooser host matches the canonical order including Close Window', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null).filter((id) => id !== null)
    expect(ids).toEqual([
      'new-window',
      'new-install',
      'track',
      'load-snapshot',
      'settings',
      'feedback',
      'exit-window',
      'close-all-windows',
    ])
  })

  it('install host matches the canonical order with Close Window between Send Feedback and Quit Desktop', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: 'inst-1' }))
    const ids = items.map((i) => i.id ?? null).filter((id) => id !== null)
    expect(ids).toEqual([
      'new-window',
      'new-install',
      'track',
      'load-snapshot',
      'settings',
      'feedback',
      'exit-window',
      'close-all-windows',
    ])
    const closeWindow = items.find((i) => i.id === 'exit-window')
    expect(closeWindow?.label).toBe('Close Window')
    const quit = items.find((i) => i.id === 'close-all-windows')
    expect(quit?.label).toBe('Quit Desktop')
  })

  it('install host omits Return to Dashboard — picker Home is the canonical dashboard escape', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: 'inst-1' }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids).not.toContain('return-to-dashboard')
  })

  it('exposes Reset Zoom on chooser host when comfy zoom is non-zero, with the percent in the label', () => {
    const noZoom = buildTitlePopupMenuItems(makeEntry({ installationId: null, zoomLevel: 0 }))
    expect(noZoom.find((i) => i.id === 'reset-zoom')).toBeUndefined()

    // 1.2^2 ≈ 1.44 → 144 %
    const zoomed = buildTitlePopupMenuItems(makeEntry({ installationId: null, zoomLevel: 2 }))
    const resetZoom = zoomed.find((i) => i.id === 'reset-zoom')
    expect(resetZoom).toBeDefined()
    expect(resetZoom?.label).toBe('Reset Zoom (144%)')
  })

  it('exposes Reset Zoom on install host when comfy zoom is non-zero', () => {
    const zoomed = buildTitlePopupMenuItems(
      makeEntry({ installationId: 'inst-1', zoomLevel: 2 }),
    )
    const resetZoom = zoomed.find((i) => i.id === 'reset-zoom')
    expect(resetZoom).toBeDefined()
    expect(resetZoom?.label).toBe('Reset Zoom (144%)')
  })

  it('omits Reset Zoom from the chooser host menu when the comfy webContents has been destroyed', () => {
    const items = buildTitlePopupMenuItems(
      makeEntry({ installationId: null, comfyDestroyed: true, zoomLevel: 2 }),
    )
    expect(items.find((i) => i.id === 'reset-zoom')).toBeUndefined()
  })

  it('places New Window first and Quit Desktop last on a chooser host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids[0]).toBe('new-window')
    expect(ids[ids.length - 1]).toBe('close-all-windows')
  })

  it('separators bracket the install-creation block on both hosts', () => {
    for (const installationId of [null, 'inst-1'] as const) {
      const items = buildTitlePopupMenuItems(makeEntry({ installationId }))
      const newWindowIdx = items.findIndex((i) => i.id === 'new-window')
      expect(items[newWindowIdx + 1]?.kind).toBe('separator')
      const newInstallIdx = items.findIndex((i) => i.id === 'new-install')
      expect(newInstallIdx).toBeGreaterThan(newWindowIdx + 1)
    }
  })

  // Loading-lockdown keeps the full menu live so the user can act while a long op runs.
  it('returns the same item set during loading-lockdown as in normal mode', () => {
    for (const installationId of [null, 'inst-1'] as const) {
      const normal = buildTitlePopupMenuItems(makeEntry({ installationId }))
      const locked = buildTitlePopupMenuItems(
        makeEntry({ installationId, firstUseMode: 'loading-lockdown' }),
      )
      expect(locked.map((i) => i.id ?? null)).toEqual(normal.map((i) => i.id ?? null))
    }
  })
})

describe('decideFlowMenuItemTarget', () => {
  const flowIds: FlowMenuItemId[] = ['new-install', 'track', 'load-snapshot', 'quick-install']

  it.each(flowIds)('dashboard host routes %s to in-place takeover', (id) => {
    const target = decideFlowMenuItemTarget(makeEntry({ installationId: null }), id)
    expect(target).toEqual({ kind: 'set-active-panel', panel: id })
  })

  it.each(flowIds)('install host routes %s to a fresh chooser window', (id) => {
    const target = decideFlowMenuItemTarget(makeEntry({ installationId: 'inst-1' }), id)
    expect(target).toEqual({ kind: 'open-chooser-host', panel: id })
  })
})

describe('isFlowMenuItemId', () => {
  it('accepts the four flow ids and rejects everything else', () => {
    expect(isFlowMenuItemId('new-install')).toBe(true)
    expect(isFlowMenuItemId('track')).toBe(true)
    expect(isFlowMenuItemId('load-snapshot')).toBe(true)
    expect(isFlowMenuItemId('quick-install')).toBe(true)
    expect(isFlowMenuItemId('new-window')).toBe(false)
    expect(isFlowMenuItemId('settings')).toBe(false)
    expect(isFlowMenuItemId('feedback')).toBe(false)
    expect(isFlowMenuItemId('')).toBe(false)
  })
})

describe('resolvePickerSelectedInstallId', () => {
  function makeInstall(overrides: Partial<InstancePickerInstall>): InstancePickerInstall {
    return {
      id: 'x',
      name: 'X',
      sourceLabel: 'Standalone',
      sourceCategory: 'local',
      ...overrides,
    } as InstancePickerInstall
  }

  it('prefers an explicit selection over the host install', () => {
    const installs = [makeInstall({ id: 'a' }), makeInstall({ id: 'b' })]
    expect(resolvePickerSelectedInstallId('b', 'a', installs)).toBe('b')
  })

  it('falls back to the host install when no explicit selection', () => {
    const installs = [makeInstall({ id: 'a' }), makeInstall({ id: 'b' })]
    expect(resolvePickerSelectedInstallId(null, 'b', installs)).toBe('b')
  })

  it('defaults to the most-recently-launched install on an install-less host', () => {
    // 'b' (most recent) is second to prove recency, not list order, decides the default.
    const installs = [
      makeInstall({ id: 'a', lastLaunchedAt: 1000 }),
      makeInstall({ id: 'b', lastLaunchedAt: 5000 }),
      makeInstall({ id: 'c', lastLaunchedAt: 2000 }),
    ]
    expect(resolvePickerSelectedInstallId(null, null, installs)).toBe('b')
  })

  it('falls back to the first install on an install-less host when none have been launched', () => {
    const installs = [makeInstall({ id: 'a' }), makeInstall({ id: 'b' })]
    expect(resolvePickerSelectedInstallId(null, null, installs)).toBe('a')
  })

  it('does not default to the seeded cloud entry just because it sorts first', () => {
    // The seeded cloud install sorts first but has no launch history; a real install wins.
    const installs = [
      makeInstall({ id: 'cloud', sourceCategory: 'cloud' }),
      makeInstall({ id: 'local-a', sourceCategory: 'local' }),
      makeInstall({ id: 'local-b', sourceCategory: 'local' }),
    ]
    expect(resolvePickerSelectedInstallId(null, null, installs)).toBe('local-a')
  })

  it('still defaults to cloud when it was genuinely launched most-recently', () => {
    const installs = [
      makeInstall({ id: 'local-a', sourceCategory: 'local', lastLaunchedAt: 1000 }),
      makeInstall({ id: 'cloud', sourceCategory: 'cloud', lastLaunchedAt: 5000 }),
    ]
    expect(resolvePickerSelectedInstallId(null, null, installs)).toBe('cloud')
  })

  it('falls back to cloud when it is the only install', () => {
    const installs = [makeInstall({ id: 'cloud', sourceCategory: 'cloud' })]
    expect(resolvePickerSelectedInstallId(null, null, installs)).toBe('cloud')
  })

  it('returns null when there are no installs to select', () => {
    expect(resolvePickerSelectedInstallId(null, null, [])).toBeNull()
  })
})

describe('buildInstancePickerSnapshot', () => {
  function makeInstall(overrides: Partial<InstancePickerInstall>): InstancePickerInstall {
    return {
      id: 'x',
      name: 'X',
      sourceLabel: 'Standalone',
      sourceCategory: 'local',
      ...overrides,
    } as InstancePickerInstall
  }

  const EMPTY_STORAGE = {
    sharedDirectoriesFields: [],
    modelsDirs: [],
    modelsSystemDefault: '',
  }

  it('forwards the install array verbatim under `installs`', () => {
    const installs = [
      makeInstall({ id: 'a', name: 'A' }),
      makeInstall({ id: 'b', name: 'B' }),
    ]
    const snap = buildInstancePickerSnapshot({
      installs,
      hostInstallationId: null,
      runningInstallationIds: [],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.installs).toEqual(installs)
  })

  it('echoes the host installation id under `activeInstallationId`', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: 'a',
      runningInstallationIds: [],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.activeInstallationId).toBe('a')
  })

  it('sets `activeInstallationId` to null on an install-less host', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: [],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.activeInstallationId).toBeNull()
  })

  it('flattens running ids into a stable string array', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: ['b', 'a', 'c'],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.runningInstallationIds).toEqual(['b', 'a', 'c'])
  })

  it('returns an empty runningInstallationIds when nothing is running', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: null,
      runningInstallationIds: [],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.runningInstallationIds).toEqual([])
  })

  it('falls back to previewInstallationId when no real attach yet', () => {
    // Chooser host that staked an attach claim pre-launch: previewInstallationId
    // is set while installationId is still null, but it should still "own" the install.
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: null,
      previewInstallationId: 'a',
      runningInstallationIds: [],
      launchingInstallationIds: ['a'],
      storage: EMPTY_STORAGE,
    })
    expect(snap.activeInstallationId).toBe('a')
  })

  it('prefers the real hostInstallationId over previewInstallationId', () => {
    // Once `attachInstall` runs, the real id takes over; a stale preview must not override it.
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' }), makeInstall({ id: 'b' })],
      hostInstallationId: 'a',
      previewInstallationId: 'b',
      runningInstallationIds: ['a'],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.activeInstallationId).toBe('a')
  })

  it('surfaces launchingInstallationIds verbatim for popup hydration', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: null,
      runningInstallationIds: [],
      launchingInstallationIds: ['a', 'b'],
      storage: EMPTY_STORAGE,
    })
    expect(snap.launchingInstallationIds).toEqual(['a', 'b'])
  })

  // The picker treats `selectedInstallationId` as authoritative only when
  // `pickerSelectionEpoch` advances; only `openInstancePickerForHost` bumps it.
  it('defaults pickerSelectionEpoch to 0 when not provided', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: [],
      launchingInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.pickerSelectionEpoch).toBe(0)
  })

  it('preserves pickerSelectionEpoch verbatim when provided', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: [],
      launchingInstallationIds: [],
      pickerSelectionEpoch: 7,
      storage: EMPTY_STORAGE,
    })
    expect(snap.pickerSelectionEpoch).toBe(7)
  })
})

