import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

const mockConfirm = vi.fn()
const mockAlert = vi.fn()
vi.mock('./useModal', () => ({
  useModal: () => ({ confirm: mockConfirm, alert: mockAlert }),
}))

const mockCheckBeforeAction = vi.fn()
vi.mock('./useActionGuard', () => ({
  useActionGuard: () => ({ checkBeforeAction: mockCheckBeforeAction }),
}))

const mockCheckBeforeLaunch = vi.fn()
vi.mock('./useLocalInstanceGuard', () => ({
  useLocalInstanceGuard: () => ({ checkBeforeLaunch: mockCheckBeforeLaunch }),
}))

vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
  toErrorBucket: vi.fn(() => 'other'),
}))

vi.mock('../lib/progressOpKind', () => ({
  progressOpKindForActionId: vi.fn(() => 'misc'),
  destroysInstanceForActionId: vi.fn(() => false),
}))

vi.mock('../lib/stopWarning', () => ({
  IN_PLACE_RELAUNCH: new Set<string>(),
  augmentMessageWithStopWarning: vi.fn((base: string | undefined, warn: string) => `${base ?? ''}\n${warn}`),
  stopAndWaitForExit: vi.fn(async () => {}),
}))

const mockRunAction = vi.fn()
vi.stubGlobal('window', {
  ...window,
  api: { runAction: mockRunAction },
})

import { useListAction } from './useListAction'
import type { Installation, ListAction } from '../types/ipc'

function makeInstall(overrides: Partial<Installation> = {}): Installation {
  return {
    id: 'inst-1',
    name: 'Legacy Desktop',
    sourceLabel: 'Legacy Desktop',
    sourceCategory: 'desktop',
    sourceId: 'desktop',
    status: 'installed',
    ...overrides,
  } as Installation
}

const launchAction: ListAction = {
  id: 'launch',
  label: 'Launch',
  style: 'primary',
  enabled: true,
}

describe('useListAction — desktop launch interceptor', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    mockConfirm.mockReset()
    mockAlert.mockReset()
    mockCheckBeforeAction.mockReset()
    mockCheckBeforeLaunch.mockReset()
    mockRunAction.mockReset()
    mockCheckBeforeAction.mockResolvedValue(true)
    mockCheckBeforeLaunch.mockResolvedValue(true)
  })

  it('on confirm: emits show-progress with an apiCall that chains migrate → launch', async () => {
    mockConfirm.mockResolvedValueOnce(true)
    mockRunAction
      .mockResolvedValueOnce({ ok: true, newInstallationId: 'inst-adopted-1' }) // migrate-to-standalone
      .mockResolvedValueOnce({ ok: true }) // launch on adopted

    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(makeInstall({ adopted: false }), launchAction)

    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({
      title: 'desktop.migrateBeforeLaunchTitle',
    }))
    expect(showProgress).toHaveBeenCalledOnce()
    const opts = showProgress.mock.calls[0]![0] as { apiCall: () => Promise<unknown> }
    const apiResult = await opts.apiCall()
    expect(mockRunAction).toHaveBeenNthCalledWith(1, 'inst-1', 'migrate-to-standalone')
    expect(mockRunAction).toHaveBeenNthCalledWith(2, 'inst-adopted-1', 'launch')
    expect(apiResult).toEqual({ ok: true })
  })

  it('on cancel: emits nothing — neither migrate nor launch run', async () => {
    mockConfirm.mockResolvedValueOnce(false)
    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(makeInstall({ adopted: false }), launchAction)

    expect(showProgress).not.toHaveBeenCalled()
    expect(mockRunAction).not.toHaveBeenCalled()
  })

  it('skips the interceptor when the install is already adopted', async () => {
    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(makeInstall({ adopted: true }), { ...launchAction, showProgress: true, progressTitle: 'Launch' })

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(showProgress).toHaveBeenCalledOnce()
    // Normal launch path emits a runAction(inst.id, 'launch') in its apiCall.
    const opts = showProgress.mock.calls[0]![0] as { apiCall: () => Promise<unknown> }
    void opts.apiCall()
    expect(mockRunAction).toHaveBeenCalledWith('inst-1', 'launch')
  })

  it('skips the interceptor for non-desktop sources', async () => {
    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(makeInstall({ sourceId: 'standalone', sourceCategory: 'local' }), { ...launchAction, showProgress: true })

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(showProgress).toHaveBeenCalledOnce()
  })

  it('apiCall short-circuits if migrate fails — does not attempt launch', async () => {
    mockConfirm.mockResolvedValueOnce(true)
    mockRunAction.mockResolvedValueOnce({ ok: false, message: 'no-legacy-install' })

    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })
    await executeAction(makeInstall({ adopted: false }), launchAction)

    const opts = showProgress.mock.calls[0]![0] as { apiCall: () => Promise<unknown> }
    const apiResult = await opts.apiCall()
    expect(mockRunAction).toHaveBeenCalledTimes(1)
    expect(apiResult).toEqual({ ok: false, message: 'no-legacy-install' })
  })
})
