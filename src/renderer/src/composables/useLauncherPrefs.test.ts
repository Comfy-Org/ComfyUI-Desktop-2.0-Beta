import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', {
  ...window,
  api: {
    getInstallations: vi.fn().mockResolvedValue([]),
    onInstallationsChanged: vi.fn(),
    onInstallationsVersionsUpdated: vi.fn(),
    getSetting: vi.fn().mockResolvedValue(undefined),
    setSetting: vi.fn().mockResolvedValue(undefined),
  }
})

// useLauncherPrefs has module-level shared state (firstUseCompleted,
// loadPromise) that must be reset between tests via the test-only
// `__resetLauncherPrefsForTest` helper.

import { useLauncherPrefs, __resetLauncherPrefsForTest } from './useLauncherPrefs'

describe('useLauncherPrefs', () => {
  let prefs: ReturnType<typeof useLauncherPrefs>

  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    vi.clearAllMocks()
    __resetLauncherPrefsForTest()
    prefs = useLauncherPrefs()
  })

  describe('loadPrefs', () => {
    it('populates firstUseCompleted from getSetting', async () => {
      vi.mocked(window.api.getSetting).mockImplementation((key: string) => {
        if (key === 'firstUseCompleted') return Promise.resolve(true)
        return Promise.resolve(undefined)
      })

      await prefs.loadPrefs()

      expect(prefs.firstUseCompleted.value).toBe(true)
      expect(prefs.loaded.value).toBe(true)
    })

    it('treats a missing firstUseCompleted as false', async () => {
      vi.mocked(window.api.getSetting).mockResolvedValue(undefined)

      await prefs.loadPrefs()

      expect(prefs.firstUseCompleted.value).toBe(false)
      expect(prefs.loaded.value).toBe(true)
    })
  })

  describe('markFirstUseCompleted', () => {
    it('sets the persisted firstUseCompleted flag', async () => {
      await prefs.markFirstUseCompleted()

      expect(prefs.firstUseCompleted.value).toBe(true)
      expect(window.api.setSetting).toHaveBeenCalledWith('firstUseCompleted', true)
    })

    it('is idempotent — a second call is a no-op', async () => {
      await prefs.markFirstUseCompleted()
      await prefs.markFirstUseCompleted()

      expect(window.api.setSetting).toHaveBeenCalledTimes(1)
    })
  })
})
