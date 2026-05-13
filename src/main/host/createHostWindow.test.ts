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
import { expectedPartitionFor } from './createHostWindow'

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
