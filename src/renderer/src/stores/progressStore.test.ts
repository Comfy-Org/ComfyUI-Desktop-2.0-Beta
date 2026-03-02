import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProgressStore } from './progressStore'
import { useSessionStore } from './sessionStore'
import type { ActionResult } from '../types/ipc'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.stubGlobal('window', {
  ...window,
  api: {
    onInstallProgress: vi.fn(() => vi.fn()),
    onComfyOutput: vi.fn(() => vi.fn()),
    cancelOperation: vi.fn(),
    stopComfyUI: vi.fn(),
  },
})

function startWithResult(
  store: ReturnType<typeof useProgressStore>,
  installationId: string,
  result: ActionResult
): Promise<void> {
  const apiCall = vi.fn().mockResolvedValue(result)
  store.startOperation({
    installationId,
    title: 'Test Launch',
    apiCall,
  })
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useProgressStore', () => {
  let store: ReturnType<typeof useProgressStore>
  let sessionStore: ReturnType<typeof useSessionStore>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    store = useProgressStore()
    sessionStore = useSessionStore()
    vi.clearAllMocks()
  })

  describe('cancelled operation', () => {
    it('does not set error state', async () => {
      await startWithResult(store, 'inst-1', { ok: false, cancelled: true })

      const op = store.operations.get('inst-1')
      expect(op?.finished).toBe(true)
      expect(op?.error).toBeNull()
      expect(op?.result?.cancelled).toBe(true)
      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })

    it('clears active session', async () => {
      await startWithResult(store, 'inst-1', { ok: false, cancelled: true })

      expect(sessionStore.activeSessions.has('inst-1')).toBe(false)
    })
  })

  describe('failed operation', () => {
    it('sets error state and adds to errorInstances', async () => {
      await startWithResult(store, 'inst-1', {
        ok: false,
        message: 'Process crashed',
      })

      const op = store.operations.get('inst-1')
      expect(op?.finished).toBe(true)
      expect(op?.error).toBe('Process crashed')
      expect(sessionStore.errorInstances.has('inst-1')).toBe(true)
      expect(sessionStore.errorInstances.get('inst-1')?.message).toBe(
        'Process crashed'
      )
    })
  })

  describe('successful operation', () => {
    it('does not set error state', async () => {
      await startWithResult(store, 'inst-1', { ok: true, mode: 'window' })

      const op = store.operations.get('inst-1')
      expect(op?.finished).toBe(true)
      expect(op?.error).toBeNull()
      expect(op?.result?.ok).toBe(true)
      expect(sessionStore.errorInstances.has('inst-1')).toBe(false)
    })
  })
})
