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
