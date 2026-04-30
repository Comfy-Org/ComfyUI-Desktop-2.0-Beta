import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stub telemetry — emitTelemetryAction calls `window.dispatchEvent`, which
// isn't preserved through `vi.stubGlobal('window', ...)` in happy-dom.
// We don't assert on telemetry here; it's exercised in component tests.
vi.mock('../lib/telemetry', () => ({
  emitTelemetryAction: vi.fn(),
}))

// The composable holds module-level state. We need a fresh module instance
// per test so refs don't leak between cases — `vi.resetModules()` + dynamic
// import inside each test guarantees that.

interface FakeStore {
  values: Map<string, unknown>
  getCalls: string[]
  setCalls: Array<{ key: string; value: unknown }>
}

function setupApi(initial: Record<string, unknown> = {}): FakeStore {
  const values = new Map<string, unknown>(Object.entries(initial))
  const getCalls: string[] = []
  const setCalls: Array<{ key: string; value: unknown }> = []

  vi.stubGlobal('window', {
    ...window,
    api: {
      getSetting: vi.fn(async (key: string) => {
        getCalls.push(key)
        return values.get(key)
      }),
      setSetting: vi.fn(async (key: string, value: unknown) => {
        setCalls.push({ key, value })
        if (value === undefined) {
          values.delete(key)
        } else {
          values.set(key, value)
        }
      }),
    },
  })

  return { values, getCalls, setCalls }
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

async function importPrefs() {
  const mod = await import('./useOnboardingPrefs')
  return mod.useOnboardingPrefs()
}

describe('useOnboardingPrefs', () => {
  describe('loadPrefs', () => {
    it('reads all four settings from window.api on first call', async () => {
      const store = setupApi({
        onboardingCompleted: true,
        eulaAccepted: true,
        eulaAcceptedAt: 1700000000000,
        telemetryEnabled: false,
        lastUsedMode: 'cloud',
      })
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      expect(prefs.completed.value).toBe(true)
      expect(prefs.eulaAccepted.value).toBe(true)
      expect(prefs.eulaAcceptedAt.value).toBe(1700000000000)
      expect(prefs.telemetryEnabled.value).toBe(false)
      expect(prefs.lastUsedMode.value).toBe('cloud')
      expect(prefs.loaded.value).toBe(true)
      // Five keys queried, exactly once each
      expect(store.getCalls.sort()).toEqual([
        'eulaAccepted',
        'eulaAcceptedAt',
        'lastUsedMode',
        'onboardingCompleted',
        'telemetryEnabled',
      ])
    })

    it('treats missing settings as defaults (not-completed, telemetry on, no mode)', async () => {
      setupApi({})
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      expect(prefs.completed.value).toBe(false)
      expect(prefs.eulaAccepted.value).toBe(false)
      expect(prefs.eulaAcceptedAt.value).toBe(null)
      // Telemetry defaults to ON when unset — privacy-meaningful behavior
      expect(prefs.telemetryEnabled.value).toBe(true)
      expect(prefs.lastUsedMode.value).toBe(null)
    })

    it('coerces bogus stored modes to null', async () => {
      setupApi({ lastUsedMode: 'something-else' })
      const prefs = await importPrefs()
      await prefs.loadPrefs()
      expect(prefs.lastUsedMode.value).toBe(null)
    })

    it('is idempotent under concurrent calls (single fetch)', async () => {
      const store = setupApi({ onboardingCompleted: true })
      const prefs = await importPrefs()

      // Fire three loads in parallel — the cached promise should serve them all
      await Promise.all([prefs.loadPrefs(), prefs.loadPrefs(), prefs.loadPrefs()])

      // Each setting key was queried exactly once across the three calls
      const occurrences: Record<string, number> = {}
      for (const key of store.getCalls) {
        occurrences[key] = (occurrences[key] ?? 0) + 1
      }
      for (const k of Object.keys(occurrences)) {
        expect(occurrences[k], `${k} should be fetched once`).toBe(1)
      }
    })
  })

  describe('setEulaAccepted', () => {
    it('persists true with a timestamp', async () => {
      const before = Date.now()
      const { setCalls } = setupApi({})
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      await prefs.setEulaAccepted(true)

      expect(prefs.eulaAccepted.value).toBe(true)
      expect(prefs.eulaAcceptedAt.value).toBeGreaterThanOrEqual(before)

      const acceptedCall = setCalls.find((c) => c.key === 'eulaAccepted')
      const tsCall = setCalls.find((c) => c.key === 'eulaAcceptedAt')
      expect(acceptedCall?.value).toBe(true)
      expect(typeof tsCall?.value).toBe('number')
    })

    it('on false, deletes the timestamp (writes undefined) instead of writing null', async () => {
      // Schema for `eulaAcceptedAt` is `{ nullable: false }`. Writing `null`
      // would violate it. The composable must use `undefined` to delete the
      // key — this test guards that contract.
      const { setCalls, values } = setupApi({
        eulaAccepted: true,
        eulaAcceptedAt: 1700000000000,
      })
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      await prefs.setEulaAccepted(false)

      expect(prefs.eulaAccepted.value).toBe(false)
      expect(prefs.eulaAcceptedAt.value).toBe(null)

      const tsCall = setCalls.find((c) => c.key === 'eulaAcceptedAt' && c.value === undefined)
      expect(tsCall, 'expected setSetting("eulaAcceptedAt", undefined)').toBeDefined()
      // And the underlying store actually has the key removed
      expect(values.has('eulaAcceptedAt')).toBe(false)
    })
  })

  describe('setLastUsedMode', () => {
    it('persists cloud and local correctly', async () => {
      const { setCalls } = setupApi({})
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      await prefs.setLastUsedMode('cloud')
      expect(prefs.lastUsedMode.value).toBe('cloud')
      expect(setCalls.find((c) => c.key === 'lastUsedMode')?.value).toBe('cloud')

      await prefs.setLastUsedMode('local')
      expect(prefs.lastUsedMode.value).toBe('local')
      // Last setSetting('lastUsedMode', _) is 'local'
      const modeCalls = setCalls.filter((c) => c.key === 'lastUsedMode')
      expect(modeCalls[modeCalls.length - 1]?.value).toBe('local')
    })
  })

  describe('setTelemetry', () => {
    it('persists the flag and updates the ref', async () => {
      const { setCalls } = setupApi({})
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      await prefs.setTelemetry(false)
      expect(prefs.telemetryEnabled.value).toBe(false)
      expect(setCalls.find((c) => c.key === 'telemetryEnabled')?.value).toBe(false)

      await prefs.setTelemetry(true)
      expect(prefs.telemetryEnabled.value).toBe(true)
    })
  })

  describe('complete', () => {
    it('sets completed=true and persists onboardingCompleted', async () => {
      const { setCalls } = setupApi({})
      const prefs = await importPrefs()
      await prefs.loadPrefs()

      expect(prefs.completed.value).toBe(false)
      await prefs.complete('manual')

      expect(prefs.completed.value).toBe(true)
      const completedCall = setCalls.find((c) => c.key === 'onboardingCompleted')
      expect(completedCall?.value).toBe(true)
    })
  })
})
