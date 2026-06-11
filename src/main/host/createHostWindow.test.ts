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
  installCloseNeedsConfirm,
  isWindowLayoutable,
  shouldBailAfterCloseChoice,
  shouldBailAfterConsult,
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

describe('installCloseNeedsConfirm', () => {
  it('confirms when enabled and the close kills a local session or is the last install window', () => {
    expect(installCloseNeedsConfirm(true, true, false)).toBe(true)
    expect(installCloseNeedsConfirm(true, false, true)).toBe(true)
  })

  it('skips when the confirm preference is off, regardless of kill/last-window state', () => {
    expect(installCloseNeedsConfirm(false, true, true)).toBe(false)
  })

  it('skips when nothing is at risk (non-last, no local session)', () => {
    expect(installCloseNeedsConfirm(true, false, false)).toBe(false)
  })
})

describe('shouldShowInstallCloseConfirm', () => {
  it('shows the modal for a host that would kill a local session on a defer consult', () => {
    expect(shouldShowInstallCloseConfirm(true, 'defer', true, false, false)).toBe(true)
  })

  it('shows the modal for the last install window even with no local session at risk (closing quits)', () => {
    expect(shouldShowInstallCloseConfirm(true, 'defer', false, false, true)).toBe(true)
  })

  it('skips the modal when the confirm preference is off, even for a last install window killing a local session', () => {
    // Default experience: no prompt. The toggle gates every other condition.
    expect(shouldShowInstallCloseConfirm(false, 'defer', true, false, true)).toBe(false)
    expect(shouldShowInstallCloseConfirm(false, 'defer', false, false, true)).toBe(false)
  })

  it('skips the modal when the caller pre-cleared the close', () => {
    // Force-close paths must not block on an extra user prompt.
    expect(shouldShowInstallCloseConfirm(true, 'defer', true, true, true)).toBe(false)
  })

  it('skips the modal for a non-last cloud/remote-backed host (no local session at risk)', () => {
    expect(shouldShowInstallCloseConfirm(true, 'defer', false, false, false)).toBe(false)
  })

  it('skips the modal on a cleared or aborted consult', () => {
    // `cleared` → renderer already handled it; `aborted` → we already
    // bailed in the prior check (this case is unreachable in practice).
    expect(shouldShowInstallCloseConfirm(true, 'cleared', true, false, true)).toBe(false)
    expect(shouldShowInstallCloseConfirm(true, 'aborted', true, false, true)).toBe(false)
  })
})

describe('isWindowLayoutable', () => {
  it('is true for a live, non-minimized window', () => {
    expect(isWindowLayoutable({ isDestroyed: () => false, isMinimized: () => false })).toBe(true)
  })

  it('is false while minimized — minimized windows report a bogus content size, so laying out collapses the child views', () => {
    expect(isWindowLayoutable({ isDestroyed: () => false, isMinimized: () => true })).toBe(false)
  })

  it('is false for a destroyed window', () => {
    expect(isWindowLayoutable({ isDestroyed: () => true, isMinimized: () => false })).toBe(false)
  })

  it('is false for a destroyed window even if it never reports minimized', () => {
    expect(isWindowLayoutable({ isDestroyed: () => true, isMinimized: () => true })).toBe(false)
  })
})

describe('shouldBailAfterCloseChoice', () => {
  it('bails when the user cancelled the close-confirm modal', () => {
    expect(shouldBailAfterCloseChoice('cancel', false)).toBe(true)
  })

  it('does not bail when the user chose to close', () => {
    expect(shouldBailAfterCloseChoice('close', false)).toBe(false)
  })

  it('does not bail when a force-close lands mid-modal even on user cancel', () => {
    // Mirrors the consult re-check: a caller-side force-close that
    // arrives while the modal is open must override the user's cancel.
    expect(shouldBailAfterCloseChoice('cancel', true)).toBe(false)
  })
})


