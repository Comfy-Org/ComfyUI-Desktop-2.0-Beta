import { describe, expect, it, vi } from 'vitest'

// shared.ts (transitively imported by registry.ts) loads electron at module
// load time, so the mock has to be in place before the popup module imports.
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

// comfyDownloadManager wires `downloadEvents.on(...)` at module load only
// inside the IPC registration helper, so importing it here is safe — the
// titlePopup module exports `buildTitlePopupMenuItems` / `computePopupHeight`
// without subscribing to anything.
import {
  buildInstancePickerSnapshot,
  resolvePickerSelectedInstallId,
  buildTitlePopupMenuItems,
  computePopupHeight,
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

  it('omits install-creation entries on an install-backed host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: 'inst-1' }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids).not.toContain('new-install')
    expect(ids).not.toContain('track')
    expect(ids).not.toContain('load-snapshot')
  })

  it('chooser host includes New Window, Settings, Send Feedback, and Quit ComfyUI', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids).toContain('new-window')
    expect(ids).toContain('settings')
    expect(ids).toContain('feedback')
    expect(ids).toContain('close-all-windows')
    // The app-wide quit lives only on the dashboard host.
    const quit = items.find((i) => i.id === 'close-all-windows')
    expect(quit?.label).toBe('Quit ComfyUI')
  })

  // Install-host menu was deliberately trimmed (spec item 1): no
  // Desktop Settings, no Return to Dashboard (replaced by the Home
  // icon in the picker, spec item 10), no Reset Zoom (Ctrl/Cmd+0
  // shortcut still works). "Quit ComfyUI" stays available from every
  // window; "Close Window" is the instance-only counterpart. The four
  // entries are New Window, Send Beta Feedback, Close Window, Quit ComfyUI.
  it('install-host menu is trimmed to four essentials in the canonical order', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: 'inst-1' }))
    const ids = items.map((i) => i.id ?? null).filter((id) => id !== null)
    expect(ids).toEqual(['new-window', 'feedback', 'exit-window', 'close-all-windows'])
    const closeWindow = items.find((i) => i.id === 'exit-window')
    expect(closeWindow?.label).toBe('Close Window')
    const quit = items.find((i) => i.id === 'close-all-windows')
    expect(quit?.label).toBe('Quit ComfyUI')
  })

  it('install-host menu has neither Reset Zoom nor Return to Dashboard', () => {
    const items = buildTitlePopupMenuItems(
      makeEntry({ installationId: 'inst-1', zoomLevel: 2 }),
    )
    const ids = items.map((i) => i.id ?? null)
    expect(ids).not.toContain('reset-zoom')
    expect(ids).not.toContain('return-to-dashboard')
    expect(ids).not.toContain('settings')
  })

  it('exposes Reset Zoom on chooser host only when comfy zoom is non-zero, with the percent in the label', () => {
    const noZoom = buildTitlePopupMenuItems(makeEntry({ installationId: null, zoomLevel: 0 }))
    expect(noZoom.find((i) => i.id === 'reset-zoom')).toBeUndefined()

    // 1.2^2 ≈ 1.44 → 144 %
    const zoomed = buildTitlePopupMenuItems(makeEntry({ installationId: null, zoomLevel: 2 }))
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

  it('places New Window first and Close All Windows last on a chooser host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids[0]).toBe('new-window')
    expect(ids[ids.length - 1]).toBe('close-all-windows')
  })

  it('separators bracket the optional install-creation block on chooser', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const newWindowIdx = items.findIndex((i) => i.id === 'new-window')
    expect(items[newWindowIdx + 1]?.kind).toBe('separator')
    const newInstallIdx = items.findIndex((i) => i.id === 'new-install')
    expect(newInstallIdx).toBeGreaterThan(newWindowIdx + 1)
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
    // Order in the list must NOT decide the default — recency does. Put the
    // most-recently-launched install ('b') second to prove list order loses.
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
    // The auto-seeded "Comfy Cloud" install is first in the registry but has
    // no launch history — a real install must win the default so it stays
    // fair for users who never open cloud.
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
      storage: EMPTY_STORAGE,
    })
    expect(snap.installs).toEqual(installs)
  })

  it('echoes the host installation id under `activeInstallationId`', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: 'a',
      runningInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.activeInstallationId).toBe('a')
  })

  it('sets `activeInstallationId` to null on an install-less host', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.activeInstallationId).toBeNull()
  })

  it('flattens running ids into a stable string array', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: ['b', 'a', 'c'],
      storage: EMPTY_STORAGE,
    })
    expect(snap.runningInstallationIds).toEqual(['b', 'a', 'c'])
  })

  it('returns an empty runningInstallationIds when nothing is running', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: null,
      runningInstallationIds: [],
      storage: EMPTY_STORAGE,
    })
    expect(snap.runningInstallationIds).toEqual([])
  })
})

