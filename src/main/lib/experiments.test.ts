import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let testUserData = ''

// Per-test temp dir. `configDir()` resolves via paths.ts which on Linux
// bypasses Electron and reads XDG_CONFIG_HOME directly — that broke CI
// when we only mocked `electron.app.getPath`. Mock paths.ts directly so
// the test path is consistent across platforms.
vi.mock('./paths', () => ({
  configDir: () => testUserData
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testUserData,
    isPackaged: true,
    on: () => {}
  }
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
    aliasImmediate(): Promise<void> {
      return Promise.resolve()
    }
    captureException(): void {}
    flush(): Promise<void> {
      return Promise.resolve()
    }
    shutdown(): Promise<void> {
      return Promise.resolve()
    }
    getFeatureFlag(): Promise<undefined> {
      return Promise.resolve(undefined)
    }
    getAllFlags(_distinctId: string, _opts: unknown): Promise<Record<string, string | boolean>> {
      if (mockFlagsDelayMs > 0) {
        return new Promise((resolve) =>
          setTimeout(() => resolve({ ...mockFlags }), mockFlagsDelayMs)
        )
      }
      return Promise.resolve({ ...mockFlags })
    }
  }
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
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
    telemetry.setConsentState('granted')
    telemetry.identify('test-distinct-id')
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    try {
      fs.rmSync(testUserData, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('initExperiments', () => {
    it('loads cache synchronously on init even before the background fetch resolves', async () => {
      // Pre-seed an on-disk cache.
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.a': 'treatment', 'flag.b': true })
      )

      mockFlagsDelayMs = 100 // ensure the network fetch is in-flight when we check getFlag
      const refresh = experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })
      // Cache is available synchronously.
      expect(experiments.getFlag('flag.a')).toBe('treatment')
      expect(experiments.getFlag('flag.b')).toBe(true)
      await refresh
    })

    it('returns undefined for unknown flags', async () => {
      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })
      expect(experiments.getFlag('nope.flag')).toBeUndefined()
    })

    it('writes refreshed values to disk for the next boot WITHOUT changing this session', async () => {
      // Pre-seed disk with the "old" assignments this session should keep.
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.x': 'control', 'flag.y': true })
      )
      // Refresh returns DIFFERENT values — the new shape PostHog wants.
      mockFlags = { 'flag.x': 'variant_a', 'flag.y': false }

      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })

      // In-memory cache is LOCKED to what loaded synchronously at boot.
      // The session keeps serving the pre-seeded values; a banner that
      // checks the flag mid-session sees the same variant as one that
      // checks at boot. No mid-session flips.
      expect(experiments.getFlag('flag.x')).toBe('control')
      expect(experiments.getFlag('flag.y')).toBe(true)

      // Disk reflects the refreshed values — next boot picks them up.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(testUserData, 'experiment-flags.json'), 'utf-8')
      )
      expect(onDisk).toEqual({ 'flag.x': 'variant_a', 'flag.y': false })
    })

    it('first-boot users (no on-disk cache) stay in fallback for the session even after refresh resolves', async () => {
      // No pre-seeded cache file. mockFlags will assign treatment.
      mockFlags = { 'flag.x': 'treatment' }

      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })

      // Even though the fetch returned 'treatment' and wrote it to disk,
      // the in-memory cache for THIS session stays empty — first-boot
      // users always land in fallback control for their first session
      // and pick up their real assignment on the next launch.
      expect(experiments.getFlag('flag.x')).toBeUndefined()

      // Disk is primed for the next boot.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(testUserData, 'experiment-flags.json'), 'utf-8')
      )
      expect(onDisk).toEqual({ 'flag.x': 'treatment' })
    })

    it('keeps the previous cache when the refresh returns an empty map (treats empty as ambiguous)', async () => {
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.a': 'treatment' })
      )
      mockFlags = {} // simulate timeout/empty response
      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })
      expect(experiments.getFlag('flag.a')).toBe('treatment')
    })

    it('is idempotent within a process — repeated init is a no-op', async () => {
      // Pre-seed disk so this session's in-memory cache is non-empty.
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.a': 'treatment' })
      )
      mockFlags = { 'flag.a': 'control' } // distinct from the seed
      const first = experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })
      const second = experiments.initExperiments({
        distinctId: 'whatever-else',
        personProperties: {}
      })
      await Promise.all([first, second])
      // The second init is a no-op — distinctId is intentionally ignored
      // (variant stability), and the session keeps its boot-loaded
      // value, NOT the mockFlags refresh value.
      expect(experiments.getFlag('flag.a')).toBe('treatment')
    })
  })

  describe('recordExposure', () => {
    it('fires comfy.desktop.experiment.exposed once per (experiment, variant) per session', () => {
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'cache')
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'cache')
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'remote')

      const events = captured.filter((c) => c.event === 'comfy.desktop.experiment.exposed')
      expect(events).toHaveLength(1)
      expect(events[0]?.properties).toMatchObject({
        experiment_key: 'auth_banner_smoketest_v1',
        variant: 'treatment',
        source: 'cache'
      })
    })

    it('fires once per variant per session — different variants of the same experiment fire separately', () => {
      experiments.recordExposure('auth_banner_smoketest_v1', 'control', 'cache')
      experiments.recordExposure('auth_banner_smoketest_v1', 'treatment', 'cache')

      const events = captured.filter((c) => c.event === 'comfy.desktop.experiment.exposed')
      expect(events).toHaveLength(2)
    })
  })
})
