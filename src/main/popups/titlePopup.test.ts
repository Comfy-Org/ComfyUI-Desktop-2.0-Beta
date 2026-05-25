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
  buildTitlePopupMenuItems,
  computePopupHeight,
  GLOBAL_SETTINGS_ALLOWED_ACTIONS,
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
    expect(ids).toContain('return-to-dashboard')
  })

  it('always includes New Window, Settings, Send Feedback, and Close All Windows', () => {
    for (const installationId of [null, 'inst-1']) {
      const ids = buildTitlePopupMenuItems(makeEntry({ installationId }))
        .map((i) => i.id ?? null)
      expect(ids).toContain('new-window')
      expect(ids).toContain('settings')
      expect(ids).toContain('feedback')
      expect(ids).toContain('close-all-windows')
    }
  })

it('exposes Reset Zoom only when comfy zoom is non-zero, with the percent in the label', () => {
    const noZoom = buildTitlePopupMenuItems(makeEntry({ zoomLevel: 0 }))
    expect(noZoom.find((i) => i.id === 'reset-zoom')).toBeUndefined()

    // 1.2^2 ≈ 1.44 → 144 %
    const zoomed = buildTitlePopupMenuItems(makeEntry({ zoomLevel: 2 }))
    const resetZoom = zoomed.find((i) => i.id === 'reset-zoom')
    expect(resetZoom).toBeDefined()
    expect(resetZoom?.label).toBe('Reset Zoom (144%)')
  })

  it('omits Reset Zoom when the comfy webContents has been destroyed', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ comfyDestroyed: true, zoomLevel: 2 }))
    expect(items.find((i) => i.id === 'reset-zoom')).toBeUndefined()
  })

  it('places New Window first and Close All Windows last on a chooser host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const ids = items.map((i) => i.id ?? null)
    expect(ids[0]).toBe('new-window')
    expect(ids[ids.length - 1]).toBe('close-all-windows')
  })

  it('places Return to Dashboard before Close All Windows on an install-backed host', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: 'inst-1' }))
    const ids = items.map((i) => i.id ?? null)
    const returnIdx = ids.indexOf('return-to-dashboard')
    const closeAllIdx = ids.indexOf('close-all-windows')
    expect(returnIdx).toBeGreaterThanOrEqual(0)
    expect(closeAllIdx).toBeGreaterThan(returnIdx)
  })

  it('separators bracket the optional install-creation block on chooser', () => {
    const items = buildTitlePopupMenuItems(makeEntry({ installationId: null }))
    const newWindowIdx = items.findIndex((i) => i.id === 'new-window')
    expect(items[newWindowIdx + 1]?.kind).toBe('separator')
    const newInstallIdx = items.findIndex((i) => i.id === 'new-install')
    expect(newInstallIdx).toBeGreaterThan(newWindowIdx + 1)
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

  it('forwards the install array verbatim under `installs`', () => {
    const installs = [
      makeInstall({ id: 'a', name: 'A' }),
      makeInstall({ id: 'b', name: 'B' }),
    ]
    const snap = buildInstancePickerSnapshot({
      installs,
      hostInstallationId: null,
      runningInstallationIds: [],
    })
    expect(snap.installs).toEqual(installs)
  })

  it('echoes the host installation id under `activeInstallationId`', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: 'a',
      runningInstallationIds: [],
    })
    expect(snap.activeInstallationId).toBe('a')
  })

  it('sets `activeInstallationId` to null on an install-less host', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: [],
    })
    expect(snap.activeInstallationId).toBeNull()
  })

  it('flattens running ids into a stable string array', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [],
      hostInstallationId: null,
      runningInstallationIds: ['b', 'a', 'c'],
    })
    expect(snap.runningInstallationIds).toEqual(['b', 'a', 'c'])
  })

  it('returns an empty runningInstallationIds when nothing is running', () => {
    const snap = buildInstancePickerSnapshot({
      installs: [makeInstall({ id: 'a' })],
      hostInstallationId: null,
      runningInstallationIds: [],
    })
    expect(snap.runningInstallationIds).toEqual([])
  })
})

describe('GLOBAL_SETTINGS_ALLOWED_ACTIONS', () => {
  // Drift between the allowlist and the actual action ids emitted by the
  // sources surfaces as silent no-ops in the title-popup Global Settings
  // drawer (clicks return { ok: false, message: "Action 'X' is not
  // available." } and the popup swallows the result). This test fails
  // loudly when an id is renamed without updating the allowlist.

  it('includes every channel-card action emitted by standalone/portable sources', () => {
    // Channel-card action ids — must stay aligned with
    // standalone/updateSections.ts and sources/portable.ts.
    const channelCardActionIds = ['update-comfyui', 'copy-update', 'switch-channel']
    for (const id of channelCardActionIds) {
      expect(GLOBAL_SETTINGS_ALLOWED_ACTIONS.has(id)).toBe(true)
    }
  })

  it('includes the session-level release-update action', () => {
    // `release-update` is dispatched from `sessionActions/copy.ts` as the
    // continuation of a copy-then-update flow. It is allowed through the
    // popup so the Global Settings drawer can drive the full chain.
    expect(GLOBAL_SETTINGS_ALLOWED_ACTIONS.has('release-update')).toBe(true)
  })

  it('does not contain the legacy "update" id (regression for #582)', () => {
    // The bare `update` id had no producer; clicks against it returned
    // "Action 'update' is not available." and the user saw nothing
    // happen. This guard keeps it from sneaking back in.
    expect(GLOBAL_SETTINGS_ALLOWED_ACTIONS.has('update')).toBe(false)
  })
})
