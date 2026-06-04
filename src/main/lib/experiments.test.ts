import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let testUserData = ''

// Mock paths.ts directly: configDir() reads XDG_CONFIG_HOME on Linux, bypassing
// the electron.app.getPath mock and breaking CI.
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
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.a': 'treatment', 'flag.b': true })
      )

      mockFlagsDelayMs = 100 // keep the fetch in-flight while we check getFlag
      const refresh = experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })
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
      fs.writeFileSync(
        path.join(testUserData, 'experiment-flags.json'),
        JSON.stringify({ 'flag.x': 'control', 'flag.y': true })
      )
      mockFlags = { 'flag.x': 'variant_a', 'flag.y': false }

      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })

      // In-memory cache stays locked to boot values; no mid-session flips.
      expect(experiments.getFlag('flag.x')).toBe('control')
      expect(experiments.getFlag('flag.y')).toBe(true)

      // Disk reflects the refreshed values for the next boot.
      const onDisk = JSON.parse(
        fs.readFileSync(path.join(testUserData, 'experiment-flags.json'), 'utf-8')
      )
      expect(onDisk).toEqual({ 'flag.x': 'variant_a', 'flag.y': false })
    })

    it('first-boot users (no on-disk cache) stay in fallback for the session even after refresh resolves', async () => {
      mockFlags = { 'flag.x': 'treatment' }

      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })

      // First-boot session stays empty even though the fetch wrote to disk.
      expect(experiments.getFlag('flag.x')).toBeUndefined()

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
      mockFlags = {} // timeout/empty response
      await experiments.initExperiments({
        distinctId: 'test-distinct-id',
        personProperties: {}
      })
      expect(experiments.getFlag('flag.a')).toBe('treatment')
    })

    it('is idempotent within a process — repeated init is a no-op', async () => {
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
      // Second init is a no-op; the session keeps the boot value.
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
