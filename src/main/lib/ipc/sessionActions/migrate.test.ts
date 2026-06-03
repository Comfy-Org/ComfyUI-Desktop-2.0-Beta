// @vitest-environment node
/**
 * Unit-level coverage for the `migrate-to-standalone` dispatcher.
 *
 * Pins the two-branch shape of `handleMigrateToStandalone`:
 *   - `inst.sourceId === 'desktop'` → routes to `adoptDesktopInstall`
 *     and returns `{ ok: true, navigate: 'list', newInstallationId }`.
 *   - everything else → routes to `performLocalMigration` with the legacy
 *     payload + return shape preserved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { InstallationRecord } from '../../../installations'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getVersion: () => '0.0.0-test', getLocale: () => 'en' },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: {},
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}))

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
  init: vi.fn(async () => {}),
  getMessages: () => ({}),
  getLocale: () => 'en',
}))

vi.mock('../../telemetry', () => ({
  capture: vi.fn(),
  bucketError: vi.fn(() => 'other'),
  trackedStep: vi.fn(async (_step: string, _ctx: unknown, fn: () => Promise<unknown>) => fn()),
}))

const { performLocalMigrationMock, adoptDesktopInstallMock } = vi.hoisted(() => ({
  performLocalMigrationMock: vi.fn(),
  adoptDesktopInstallMock: vi.fn(),
}))

vi.mock('../../desktopAdopt', () => ({
  adoptDesktopInstall: adoptDesktopInstallMock,
}))

vi.mock('../shared', () => ({
  fs: { existsSync: vi.fn(() => false), promises: { rm: vi.fn(async () => {}) } },
  dialog: { showMessageBox: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  installations: { remove: vi.fn(async () => {}) },
  i18n: { t: (k: string) => k },
  performLocalMigration: performLocalMigrationMock,
  _operationAborts: new Map(),
  sourceMap: {},
  uniqueName: vi.fn(async (s: string) => s),
  makeSendProgress: vi.fn(() => vi.fn()),
  makeSendOutput: vi.fn(() => vi.fn()),
}))

import { handleMigrateToStandalone } from './migrate'

function makeContext(inst: Partial<InstallationRecord>): Parameters<typeof handleMigrateToStandalone>[0] {
  const installation = {
    id: 'src-1',
    name: 'Legacy',
    createdAt: '2026-01-01T00:00:00.000Z',
    installPath: '/legacy',
    sourceId: 'desktop',
    ...inst,
  } as InstallationRecord
  return {
    event: { sender: { send: vi.fn() } } as unknown as Electron.IpcMainInvokeEvent,
    installationId: installation.id,
    inst: installation,
    actionData: {},
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleMigrateToStandalone — desktop branch', () => {
  it('routes desktop source to adoptDesktopInstall and returns the newly-adopted id', async () => {
    adoptDesktopInstallMock.mockResolvedValueOnce({
      id: 'inst-adopted-1',
      installPath: '/adopted',
    } as InstallationRecord)

    const result = await handleMigrateToStandalone(makeContext({ sourceId: 'desktop' }))

    expect(adoptDesktopInstallMock).toHaveBeenCalledOnce()
    expect(performLocalMigrationMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      navigate: 'list',
      newInstallationId: 'inst-adopted-1',
    })
  })

  it('routes "source-missing-switch-to-managed" to new-install navigation', async () => {
    adoptDesktopInstallMock.mockRejectedValueOnce(new Error('source-missing-switch-to-managed'))
    const result = await handleMigrateToStandalone(makeContext({ sourceId: 'desktop' }))
    expect(result).toEqual({ ok: true, navigate: 'new-install' })
  })

  it('surfaces other adoption errors as failure results', async () => {
    adoptDesktopInstallMock.mockRejectedValueOnce(new Error('no-legacy-install'))
    const result = await handleMigrateToStandalone(makeContext({ sourceId: 'desktop' }))
    expect(result).toEqual({ ok: false, message: 'no-legacy-install' })
  })
})

describe('handleMigrateToStandalone — non-desktop branch', () => {
  it('routes non-desktop source to performLocalMigration', async () => {
    performLocalMigrationMock.mockResolvedValueOnce({
      entry: { id: 'inst-mig-1' },
      destPath: '/dest',
    })
    const result = await handleMigrateToStandalone(makeContext({ sourceId: 'standalone' }))

    expect(performLocalMigrationMock).toHaveBeenCalledOnce()
    expect(adoptDesktopInstallMock).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, navigate: 'list' })
  })
})
