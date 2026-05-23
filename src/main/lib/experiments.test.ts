import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let testUserData = ''

vi.mock('electron', () => ({
  app: {
    getPath: () => testUserData,
    isPackaged: false,
    on: () => {},
  },
}))

// Captured PostHog calls per the existing telemetry.test.ts pattern.
interface CapturedCall {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
}
const captured: CapturedCall[] = []

let mockFlags: Record<string, string | boolean> = {}
let mockFlagsDelayMs = 0

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(call: CapturedCall): void {
      captured.push(call)
    }
    identify(): void {}
    alias(): void {}
    aliasImmediate(): Promise<void> { return Promise.resolve() }
    captureException(): void {}
    flush(): Promise<void> { return Promise.resolve() }
    shutdown(): Promise<void> { return Promise.resolve() }
    getFeatureFlag(): Promise<undefined> { return Promise.resolve(undefined) }
    getAllFlags(_distinctId: string, _opts: unknown): Promise<Record<string, string | boolean>> {
      if (mockFlagsDelayMs > 0) {
        return new Promise((resolve) => setTimeout(() => resolve({ ...mockFlags }), mockFlagsDelayMs))
      }
      return Promise.resolve({ ...mockFlags })
    }
  },
}))

import type * as ExperimentsModule from './experiments'
import type * as TelemetryModule from './telemetry'

describe('experiments', () => {
  let experiments: typeof ExperimentsModule
  let telemetry: typeof TelemetryModule

  beforeEach(async () => {
    testUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'experiments-test-'))
    captured.length = 0
    mockFlags = {}
    mockFlagsDelayMs = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'

    vi.resetModules()
    experiments = await import('./experiments')
    telemetry = await import('./telemetry')
    telemetry._resetForTest()
    experiments._resetForTest()
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: false })
    telemetry.setConsentState('granted')
    telemetry.identify('test-distinct-id')
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    try { fs.rmSync(testUserData, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('initExperiments', () => {
    it('loads cache synchronously on init even before the background fetch resolves', async () => {
      // Pre-seed an on-disk cache.
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.a': 'treatment', 'flag.b': true }),
      )

      mockFlagsDelayMs = 100 // ensure the network fetch is in-flight when we check getFlag
      const refresh = experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {},
      })
      // Cache is available synchronously.
      expect(experiments.getFlag('flag.a')).toBe('treatment')
      expect(experiments.getFlag('flag.b')).toBe(true)
      await refresh
    })

    it('returns undefined for unknown flags', async () => {
      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {},
      })
      expect(experiments.getFlag('nope.flag')).toBeUndefined()
    })

    it('writes refreshed values to disk for the next boot', async () => {
      mockFlags = { 'flag.x': 'variant_a', 'flag.y': false }
      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {},
      })
      expect(experiments.getFlag('flag.x')).toBe('variant_a')
      expect(experiments.getFlag('flag.y')).toBe(false)
      // The new cache should be persisted.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(testUserData, 'experiment-flags.json'), 'utf-8'),
      )
      expect(onDisk).toEqual({ 'flag.x': 'variant_a', 'flag.y': false })
    })

    it('keeps the previous cache when the refresh returns an empty map (treats empty as ambiguous)', async () => {
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.a': 'treatment' }),
      )
      mockFlags = {} // simulate timeout/empty response
      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {},
      })
      expect(experiments.getFlag('flag.a')).toBe('treatment')
    })

    it('is idempotent within a process — repeated init is a no-op', async () => {
      mockFlags = { 'flag.a': 'treatment' }
      const first = experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {},
      })
      const second = experiments.initExperiments({
        distinctId: 'whatever-else',
        personProperties: {},
      })
      await Promise.all([first, second])
      // Second call shouldn't have replaced the distinctId or refetched.
      expect(experiments.getFlag('flag.a')).toBe('treatment')
    })
  })

  describe('recordExposure', () => {
    it('fires desktop2.experiment.exposed once per (experiment, variant) per session', () => {
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'cache')
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'cache')
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'remote')

      const events = captured.filter((c) => c.event === 'desktop2.experiment.exposed')
      expect(events).toHaveLength(1)
      expect(events[0]?.properties).toEqual({
        experiment_key: 'auth_banner_smoketest_v1',
        variant: 'treatment',
        source: 'cache',
      })
    })

    it('fires once per variant per session — different variants of the same experiment fire separately', () => {
      experiments.recordExposure('auth_banner_smoketest_v1', 'control', 'cache')
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'cache')

      const events = captured.filter((c) => c.event === 'desktop2.experiment.exposed')
      expect(events).toHaveLength(2)
    })
  })
})
