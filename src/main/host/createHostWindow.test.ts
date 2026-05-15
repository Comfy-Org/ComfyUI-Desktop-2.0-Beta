import { describe, expect, it, vi } from 'vitest'

// shared.ts (transitively imported by registry.ts) loads electron at module
// load, so the mock has to be in place before the host module imports.
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
import { cascadeOffsetForCollisions, expectedPartitionFor } from './createHostWindow'

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
