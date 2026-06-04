import { describe, expect, it, vi } from 'vitest'

// shared.ts (via registry.ts) loads electron at module load, so the mock
// must be in place before the host module imports.
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

import type { InstallationRecord } from '../installations'
import {
  cascadeOffsetForCollisions,
  expectedPartitionFor,
  shouldBailAfterCloseConfirm,
  shouldBailAfterConsult,
  shouldDetachLastInstallWindowToDashboard,
  shouldShowInstallCloseConfirm,
} from './createHostWindow'

function makeInstallation(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    id: 'inst-test',
    name: 'Test Install',
    sourceId: 'standalone',
    installPath: '/tmp/test',
    state: 'ready',
    ...overrides,
  } as unknown as InstallationRecord
}

describe('expectedPartitionFor', () => {
  it('returns persist:shared by default', () => {
    expect(expectedPartitionFor(makeInstallation())).toBe('persist:shared')
  })

  it('returns a per-install bucket when browserPartition is "unique"', () => {
    const inst = makeInstallation({ id: 'abc-123' } as Partial<InstallationRecord>)
    ;(inst as unknown as { browserPartition: string }).browserPartition = 'unique'
    expect(expectedPartitionFor(inst)).toBe('persist:abc-123')
  })

  it('still returns persist:shared when browserPartition is set to a non-"unique" value', () => {
    const inst = makeInstallation()
    ;(inst as unknown as { browserPartition: string }).browserPartition = 'shared'
    expect(expectedPartitionFor(inst)).toBe('persist:shared')
  })

  it('encodes the install id verbatim — no escaping or normalisation', () => {
    const inst = makeInstallation({ id: 'with spaces & symbols' } as Partial<InstallationRecord>)
    ;(inst as unknown as { browserPartition: string }).browserPartition = 'unique'
    expect(expectedPartitionFor(inst)).toBe('persist:with spaces & symbols')
  })
})

describe('cascadeOffsetForCollisions', () => {
  it('returns the input unchanged when no x/y is set (centered window)', () => {
    const opts = { width: 1280, height: 900 }
    expect(cascadeOffsetForCollisions(opts, [{ x: 100, y: 100 }])).toEqual(opts)
  })

  it('returns the input unchanged when no existing windows collide', () => {
    const opts = { x: 200, y: 300, width: 1280, height: 900 }
    expect(cascadeOffsetForCollisions(opts, [{ x: 999, y: 999 }])).toEqual(opts)
  })

  it('offsets by 30px when one existing window matches the origin', () => {
    const opts = { x: 100, y: 100, width: 1280, height: 900 }
    expect(cascadeOffsetForCollisions(opts, [{ x: 100, y: 100 }]))
      .toEqual({ x: 130, y: 130, width: 1280, height: 900 })
  })

  it('cascades past chains of pre-cascaded windows', () => {
    const opts = { x: 100, y: 100, width: 1280, height: 900 }
    const existing = [{ x: 100, y: 100 }, { x: 130, y: 130 }, { x: 160, y: 160 }]
    expect(cascadeOffsetForCollisions(opts, existing))
      .toEqual({ x: 190, y: 190, width: 1280, height: 900 })
  })

  it('skips destroyed/empty origin lists cleanly', () => {
    const opts = { x: 50, y: 50, width: 800, height: 600 }
    expect(cascadeOffsetForCollisions(opts, [])).toEqual(opts)
  })
})

// Pure decision helpers for the close handler's three `preClearedClose`
// re-check points, kept testable without mocking BrowserWindow.
describe('shouldBailAfterConsult', () => {
  it('bails when the renderer aborted and no force-close override is set', () => {
    expect(shouldBailAfterConsult('aborted', false)).toBe(true)
  })

  it('does not bail when the renderer aborted but the caller pre-cleared the close', () => {
    // Bulk Exit-All consent overrides a per-window cancel, else an unrelated
    // open prompt would strand the caller's awaited teardown.
    expect(shouldBailAfterConsult('aborted', true)).toBe(false)
  })

  it('does not bail when the renderer cleared (no overlay / user confirmed)', () => {
    expect(shouldBailAfterConsult('cleared', false)).toBe(false)
    expect(shouldBailAfterConsult('cleared', true)).toBe(false)
  })

  it('does not bail when the renderer deferred — main owns the close-confirm', () => {
    expect(shouldBailAfterConsult('defer', false)).toBe(false)
    expect(shouldBailAfterConsult('defer', true)).toBe(false)
  })
})

describe('shouldShowInstallCloseConfirm', () => {
  it('shows the modal for a host that would kill a local session on a defer consult', () => {
    expect(shouldShowInstallCloseConfirm('defer', true, false)).toBe(true)
  })

  it('skips the modal when the caller pre-cleared the close', () => {
    // Force-close paths must not block on an extra user prompt.
    expect(shouldShowInstallCloseConfirm('defer', true, true)).toBe(false)
  })

  it('skips the modal for a chooser host or a cloud/remote-backed host (no local session at risk)', () => {
    expect(shouldShowInstallCloseConfirm('defer', false, false)).toBe(false)
  })

  it('skips the modal on a cleared or aborted consult', () => {
    // `cleared` → renderer already handled it; `aborted` → we already
    // bailed in the prior check (this case is unreachable in practice).
    expect(shouldShowInstallCloseConfirm('cleared', true, false)).toBe(false)
    expect(shouldShowInstallCloseConfirm('aborted', true, false)).toBe(false)
  })
})

describe('shouldBailAfterCloseConfirm', () => {
  it('bails when the user dismissed the close-confirm modal', () => {
    expect(shouldBailAfterCloseConfirm(false, false)).toBe(true)
  })

  it('does not bail when the user confirmed the close-confirm modal', () => {
    expect(shouldBailAfterCloseConfirm(true, false)).toBe(false)
    expect(shouldBailAfterCloseConfirm(true, true)).toBe(false)
  })

  it('does not bail when a force-close lands mid-modal even on user dismiss', () => {
    // Mirrors the consult re-check: a caller-side force-close that
    // arrives while the modal is open must override the user's cancel.
    expect(shouldBailAfterCloseConfirm(false, true)).toBe(false)
  })
})

describe('shouldDetachLastInstallWindowToDashboard', () => {
  it('detaches an install host with a live entry when it is the last window', () => {
    // OS ✕ on the last install window → flip to dashboard in place.
    expect(shouldDetachLastInstallWindowToDashboard(true, true, true, false, false)).toBe(true)
  })

  it('does not detach on a force-close even if it is the last install window', () => {
    // Launch-guard swap / bulk Exit-All want the window gone, not a
    // stray dashboard window left behind.
    expect(shouldDetachLastInstallWindowToDashboard(true, true, true, true, false)).toBe(false)
  })

  it('does not detach when other host windows are still open', () => {
    expect(shouldDetachLastInstallWindowToDashboard(true, true, false, false, false)).toBe(false)
  })

  it('does not detach a chooser/dashboard host (no install backing)', () => {
    expect(shouldDetachLastInstallWindowToDashboard(false, true, true, false, false)).toBe(false)
  })

  it('does not detach when the entry has already been dropped from the registry', () => {
    expect(shouldDetachLastInstallWindowToDashboard(true, false, true, false, false)).toBe(false)
  })

  it('does not detach when a quit is in progress (Cmd+Q, app-update restart, etc.)', () => {
    // Regression for: clicking "Restart Now" in the Desktop Update modal
    // fired app.quit() which fired close on the last install window —
    // and that close was being intercepted into a dashboard-detach,
    // swallowing the quit. The first restart click was a silent no-op
    // because the window flipped to dashboard instead of destroying;
    // only the second click (after the flip) actually restarted.
    expect(shouldDetachLastInstallWindowToDashboard(true, true, true, false, true)).toBe(false)
  })
})
