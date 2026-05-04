import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'launcher-test'),
    isPackaged: false,
    on: () => {},
  },
  BrowserWindow: { getAllWindows: () => [] },
}))

interface CapturedCall {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
}
const captured: CapturedCall[] = []

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(call: CapturedCall): void {
      captured.push(call)
    }
    identify(): void {}
    captureException(): void {}
    flush(): Promise<void> { return Promise.resolve() }
    shutdown(): Promise<void> { return Promise.resolve() }
    getFeatureFlag(): Promise<undefined> { return Promise.resolve(undefined) }
  },
}))

const telemetry = await import('./telemetry')

describe('telemetry.bucketError', () => {
  it('classifies cancellation messages', () => {
    expect(telemetry.bucketError('Operation cancelled by user')).toBe('cancelled')
  })
  it('classifies timeouts', () => {
    expect(telemetry.bucketError('request timeout after 30s')).toBe('timeout')
  })
  it('classifies network errors', () => {
    expect(telemetry.bucketError('fetch failed: network unreachable')).toBe('network')
  })
  it('classifies disk-space errors', () => {
    expect(telemetry.bucketError('No space left on disk')).toBe('disk')
  })
  it('classifies permission errors', () => {
    expect(telemetry.bucketError('permission denied: /var/log')).toBe('permissions')
  })
  it('falls back to "other" for unknown messages', () => {
    expect(telemetry.bucketError('something blew up')).toBe('other')
  })
  it('returns "unknown" for empty input', () => {
    expect(telemetry.bucketError('')).toBe('unknown')
  })
  it('accepts Error instances', () => {
    expect(telemetry.bucketError(new Error('connection timeout'))).toBe('timeout')
  })
})

describe('telemetry.trackedStep', () => {
  beforeEach(async () => {
    captured.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: false })
    await telemetry.identify('test-distinct-id')
    telemetry.setConsent(true)
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    vi.restoreAllMocks()
  })

  it('emits .start and .end with duration_ms on success', async () => {
    captured.length = 0
    const result = await telemetry.trackedStep('test.step', { foo: 'bar' }, async () => 42)
    expect(result).toBe(42)
    const events = captured.map((c) => c.event)
    expect(events).toEqual(['test.step.start', 'test.step.end'])
    expect(captured[0]!.properties).toEqual({ foo: 'bar' })
    expect(typeof captured[1]!.properties?.duration_ms).toBe('number')
    expect(captured[1]!.properties?.foo).toBe('bar')
  })

  it('emits .start and .error on failure and rethrows', async () => {
    captured.length = 0
    await expect(
      telemetry.trackedStep('install.step', { id: 'x' }, async () => {
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')
    const events = captured.map((c) => c.event)
    expect(events).toEqual(['install.step.start', 'install.step.error'])
    expect(captured[1]!.properties).toMatchObject({
      id: 'x',
      error_bucket: 'disk',
      error_message: 'disk full',
    })
    expect(typeof captured[1]!.properties?.duration_ms).toBe('number')
  })

  it('respects consent: capture is skipped when consent is revoked', async () => {
    telemetry.setConsent(false)
    captured.length = 0
    await telemetry.trackedStep('test.step', {}, async () => 'ok')
    expect(captured).toHaveLength(0)
    telemetry.setConsent(true)
  })
})
