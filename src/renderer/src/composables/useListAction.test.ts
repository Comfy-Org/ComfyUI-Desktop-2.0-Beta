import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

const mockModalConfirm = vi.hoisted(() => vi.fn())
const mockModalAlert = vi.hoisted(() => vi.fn())
vi.mock('./useModal', () => ({
  useModal: () => ({ confirm: mockModalConfirm, alert: mockModalAlert }),
}))

const mockCheckBeforeAction = vi.hoisted(() => vi.fn())
vi.mock('./useActionGuard', () => ({
  useActionGuard: () => ({ checkBeforeAction: mockCheckBeforeAction }),
}))

const mockCheckBeforeLaunch = vi.hoisted(() => vi.fn())
vi.mock('./useLocalInstanceGuard', () => ({
  useLocalInstanceGuard: () => ({ checkBeforeLaunch: mockCheckBeforeLaunch }),
}))

const sessionState = vi.hoisted(() => ({
  running: new Set<string>(),
  errorCleared: [] as string[],
}))
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: () => ({
    isRunning: (id: string) => sessionState.running.has(id),
    clearErrorInstance: (id: string) => {
      sessionState.errorCleared.push(id)
    },
  }),
}))

vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
  toErrorBucket: () => 'unknown',
}))

const mockRunAction = vi.hoisted(() => vi.fn())
;(globalThis as unknown as { window: { api: { runAction: typeof mockRunAction } } }).window = {
  api: { runAction: mockRunAction },
}

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
    sessionState.running.clear()
    sessionState.errorCleared.length = 0
    mockModalConfirm.mockReset()
    mockModalAlert.mockReset()
    mockCheckBeforeAction.mockReset().mockResolvedValue(true)
    mockCheckBeforeLaunch.mockReset().mockResolvedValue(true)
    mockRunAction.mockReset()
  })

  it('on confirm: emits show-progress with an apiCall that chains migrate → launch', async () => {
    mockModalConfirm.mockResolvedValueOnce(true)
    mockRunAction
      .mockResolvedValueOnce({ ok: true, newInstallationId: 'inst-adopted-1' }) // migrate-to-standalone
      .mockResolvedValueOnce({ ok: true }) // launch on adopted

    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(makeInstall({ adopted: false }), launchAction)

    expect(mockModalConfirm).toHaveBeenCalledWith(expect.objectContaining({
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
    mockModalConfirm.mockResolvedValueOnce(false)
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

    expect(mockModalConfirm).not.toHaveBeenCalled()
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

    expect(mockModalConfirm).not.toHaveBeenCalled()
    expect(showProgress).toHaveBeenCalledOnce()
  })

  it('apiCall short-circuits if migrate fails — does not attempt launch', async () => {
    mockModalConfirm.mockResolvedValueOnce(true)
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

const INSTALL: Installation = {
  id: 'inst-launch',
  name: 'Test Install',
  sourceLabel: 'standalone',
  sourceCategory: 'local',
}

const LAUNCH_ACTION: ListAction = {
  id: 'launch',
  label: 'Launch',
  style: 'primary',
  showProgress: true,
}

describe('useListAction.executeAction onGuardsPassed hook', () => {
  beforeEach(() => {
    sessionState.running.clear()
    sessionState.errorCleared.length = 0
    mockModalConfirm.mockReset()
    mockModalAlert.mockReset()
    mockCheckBeforeAction.mockReset().mockResolvedValue(true)
    mockCheckBeforeLaunch.mockReset().mockResolvedValue(true)
    mockRunAction.mockReset().mockResolvedValue({ ok: true })
  })

  it('fires onGuardsPassed when every guard resolves positively', async () => {
    const onGuardsPassed = vi.fn(async () => {})
    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(INSTALL, LAUNCH_ACTION, { onGuardsPassed })

    expect(onGuardsPassed).toHaveBeenCalledOnce()
    expect(showProgress).toHaveBeenCalledOnce()
    // Hook must fire BEFORE showProgress so the chooser claim is in place
    // by the time the launch op is dispatched.
    expect(onGuardsPassed.mock.invocationCallOrder[0]).toBeLessThan(
      showProgress.mock.invocationCallOrder[0],
    )
  })

  it('does NOT fire onGuardsPassed when the action is disabled', async () => {
    const onGuardsPassed = vi.fn()
    const showProgress = vi.fn()
    const disabledAction: ListAction = {
      ...LAUNCH_ACTION,
      enabled: false,
      disabledMessage: 'Cannot launch right now',
    }
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(INSTALL, disabledAction, { onGuardsPassed })

    expect(mockModalAlert).toHaveBeenCalledOnce()
    expect(onGuardsPassed).not.toHaveBeenCalled()
    expect(showProgress).not.toHaveBeenCalled()
  })

  it('does NOT fire onGuardsPassed when the busy guard cancels', async () => {
    mockCheckBeforeAction.mockResolvedValueOnce(false)
    const onGuardsPassed = vi.fn()
    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(INSTALL, LAUNCH_ACTION, { onGuardsPassed })

    expect(onGuardsPassed).not.toHaveBeenCalled()
    expect(showProgress).not.toHaveBeenCalled()
  })

  it('does NOT fire onGuardsPassed when the user cancels a confirm modal', async () => {
    mockModalConfirm.mockResolvedValueOnce(false)
    const onGuardsPassed = vi.fn()
    const showProgress = vi.fn()
    const confirmedAction: ListAction = {
      ...LAUNCH_ACTION,
      confirm: { title: 'Sure?', message: 'Really?' },
    }
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(INSTALL, confirmedAction, { onGuardsPassed })

    expect(onGuardsPassed).not.toHaveBeenCalled()
    expect(showProgress).not.toHaveBeenCalled()
  })

  it('does NOT fire onGuardsPassed when the local-instance launch guard cancels', async () => {
    mockCheckBeforeLaunch.mockResolvedValueOnce(false)
    const onGuardsPassed = vi.fn()
    const showProgress = vi.fn()
    const { executeAction } = useListAction('chooser', { showProgress })

    await executeAction(INSTALL, LAUNCH_ACTION, { onGuardsPassed })

    expect(onGuardsPassed).not.toHaveBeenCalled()
    expect(showProgress).not.toHaveBeenCalled()
  })
})
