import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Capture every option the SUT passes to `posthog.init` and every method it
// calls on the returned client, so we can assert that consent state is
// mirrored into `disable_surveys` (PostHog's surveys module ignores
// `opt_out_capturing()` outside cookieless mode, so the gate has to be
// wired by us).
const initCalls: Array<Record<string, unknown>> = []
const setConfigCalls: Array<Record<string, unknown>> = []
const surveysLoadIfEnabled = vi.fn()
let optInCalled = 0
let optOutCalled = 0

vi.mock('posthog-js', () => {
  const fakeClient = {
    set_config: (cfg: Record<string, unknown>) => {
      setConfigCalls.push(cfg)
    },
    opt_in_capturing: () => {
      optInCalled++
    },
    opt_out_capturing: () => {
      optOutCalled++
    },
    surveys: {
      loadIfEnabled: surveysLoadIfEnabled,
    },
    register: () => {},
    identify: () => {},
    capture: () => {},
    captureException: () => {},
    isFeatureEnabled: () => undefined,
    reloadFeatureFlags: () => {},
  }
  return {
    default: {
      init: (_apiKey: string, opts: Record<string, unknown>) => {
        initCalls.push(opts)
        // PostHog's real `loaded` callback runs synchronously after init.
        const loaded = opts['loaded'] as undefined | ((ph: unknown) => void)
        loaded?.(fakeClient)
        return fakeClient
      },
    },
  }
})

// Stub the env Vite normally injects so `isPostHogConfigured()` returns true.
vi.stubGlobal('import.meta', { env: { VITE_POSTHOG_API_KEY: 'phc_test_key' } })

const baseOpts = {
  appVersion: '0.0.0-test',
  appEnv: 'test',
  isPackaged: false,
} as const

describe('posthogProvider consent ↔ disable_surveys gating', () => {
  beforeEach(() => {
    initCalls.length = 0
    setConfigCalls.length = 0
    surveysLoadIfEnabled.mockClear()
    optInCalled = 0
    optOutCalled = 0
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('initialises with disable_surveys: true when consent is false', async () => {
    const mod = await import('./posthogProvider')
    mod.initPostHog({ ...baseOpts, consent: false })
    expect(initCalls.length).toBe(1)
    expect(initCalls[0]?.['disable_surveys']).toBe(true)
    expect(initCalls[0]?.['opt_out_capturing_by_default']).toBe(true)
  })

  it('initialises with disable_surveys: false when consent is true', async () => {
    const mod = await import('./posthogProvider')
    mod.initPostHog({ ...baseOpts, consent: true })
    expect(initCalls[0]?.['disable_surveys']).toBe(false)
    expect(initCalls[0]?.['opt_out_capturing_by_default']).toBe(false)
  })

  it('opting out flips disable_surveys to true and opts the SDK out', async () => {
    const mod = await import('./posthogProvider')
    mod.initPostHog({ ...baseOpts, consent: true })
    mod.setPostHogConsent(false)
    expect(optOutCalled).toBe(1)
    const lastCfg = setConfigCalls[setConfigCalls.length - 1]
    expect(lastCfg?.['disable_surveys']).toBe(true)
    // Re-loading surveys is not desired on opt-out — only on opt-in.
    expect(surveysLoadIfEnabled).not.toHaveBeenCalled()
  })

  it('opting back in flips disable_surveys to false AND re-loads surveys', async () => {
    const mod = await import('./posthogProvider')
    mod.initPostHog({ ...baseOpts, consent: false })
    mod.setPostHogConsent(true)
    expect(optInCalled).toBe(1)
    const lastCfg = setConfigCalls[setConfigCalls.length - 1]
    expect(lastCfg?.['disable_surveys']).toBe(false)
    expect(surveysLoadIfEnabled).toHaveBeenCalledTimes(1)
  })
})
