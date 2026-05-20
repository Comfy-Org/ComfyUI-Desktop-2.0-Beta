import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  globalShortcut: { register: vi.fn(), unregister: vi.fn() },
}))

vi.mock('@todesktop/runtime', () => ({ default: { autoUpdater: null } }))
vi.mock('../settings', () => ({ get: vi.fn() }))

import { cycleAppUpdateState } from './devShortcuts'
import type { AppUpdateState } from './updater'

describe('cycleAppUpdateState', () => {
  it('cycles null → available → downloading → ready → null', () => {
    const idle: AppUpdateState = { kind: null, version: null, autoUpdate: true }
    const a = cycleAppUpdateState(idle)
    expect(a.kind).toBe('available')
    expect(a.version).toBeTruthy()
    expect(a.autoUpdate).toBe(false)

    const b = cycleAppUpdateState(a)
    expect(b.kind).toBe('downloading')

    const c = cycleAppUpdateState(b)
    expect(c.kind).toBe('ready')

    const d = cycleAppUpdateState(c)
    expect(d.kind).toBeNull()
    expect(d.version).toBeNull()
  })
})
