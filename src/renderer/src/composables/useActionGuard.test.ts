import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

const mockConfirm = vi.hoisted(() => vi.fn())
vi.mock('./useModal', () => ({
  useModal: () => ({ confirm: mockConfirm }),
}))

const sessionState = vi.hoisted(() => ({
  activeSessions: new Map<string, { label: string }>(),
  launching: new Set<string>(),
  stopping: new Set<string>(),
  running: new Set<string>(),
}))
vi.mock('../stores/sessionStore', () => ({
  useSessionStore: () => ({
    activeSessions: sessionState.activeSessions,
    isLaunching: (id: string) => sessionState.launching.has(id),
    isStopping: (id: string) => sessionState.stopping.has(id),
    isRunning: (id: string) => sessionState.running.has(id),
  }),
}))

const progressState = vi.hoisted(() => ({
  info: new Map<string, { status: string; percent: number } | null>(),
}))
vi.mock('../stores/progressStore', () => ({
  useProgressStore: () => ({
    getProgressInfo: (id: string) => progressState.info.get(id) ?? null,
  }),
}))

const mockCancelOperation = vi.hoisted(() => vi.fn())
;(globalThis as unknown as { window: { api: { cancelOperation: typeof mockCancelOperation } } })
  .window = { api: { cancelOperation: mockCancelOperation } }

import { useActionGuard } from './useActionGuard'

const INSTALL_ID = 'inst-guard-test'

describe('useActionGuard.checkBeforeAction', () => {
  beforeEach(() => {
    sessionState.activeSessions.clear()
    sessionState.launching.clear()
    sessionState.stopping.clear()
    sessionState.running.clear()
    progressState.info.clear()
    mockConfirm.mockReset()
    mockCancelOperation.mockReset()
  })

  it('proceeds immediately when the install is idle', async () => {
    const { checkBeforeAction } = useActionGuard()
    const ok = await checkBeforeAction(INSTALL_ID, 'Restart')
    expect(ok).toBe(true)
    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockCancelOperation).not.toHaveBeenCalled()
  })

  it('returns false without cancelling when the user dismisses the confirm', async () => {
    sessionState.launching.add(INSTALL_ID)
    mockConfirm.mockResolvedValue(false)

    const ok = await useActionGuard().checkBeforeAction(INSTALL_ID, 'Restart')

    expect(ok).toBe(false)
    expect(mockConfirm).toHaveBeenCalledOnce()
    expect(mockCancelOperation).not.toHaveBeenCalled()
  })

  it('cancels then polls until the in-flight op clears', async () => {
    sessionState.activeSessions.set(INSTALL_ID, { label: 'Updating ComfyUI' })
    progressState.info.set(INSTALL_ID, { status: 's', percent: -1 })
    mockConfirm.mockResolvedValue(true)

    const pending = useActionGuard().checkBeforeAction(INSTALL_ID, 'Restart')
    // Let the poll iterate a couple of times before the op clears.
    await new Promise((r) => setTimeout(r, 250))
    expect(mockCancelOperation).toHaveBeenCalledWith(INSTALL_ID)
    progressState.info.set(INSTALL_ID, null)

    expect(await pending).toBe(true)
  })

  it('exits the poll on the 10s deadline even if the op never clears', async () => {
    sessionState.activeSessions.set(INSTALL_ID, { label: 'Stuck' })
    progressState.info.set(INSTALL_ID, { status: 's', percent: -1 })
    mockConfirm.mockResolvedValue(true)

    vi.useFakeTimers()
    try {
      const pending = useActionGuard().checkBeforeAction(INSTALL_ID, 'Restart')
      await vi.advanceTimersByTimeAsync(10_500)
      expect(await pending).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
