import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'launcher-test'),
    isPackaged: true,
    on: () => {}
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

/**
 * Build a stub WebContents that records `send()` calls and emits
 * `'destroyed'` so the relay registry can self-clean. Mirrors the surface
 * the production registry actually consumes.
 */
function makeStubWebContents(): {
  wc: Electron.WebContents
  sends: { channel: string; data: unknown }[]
  destroy: () => void
} {
  const sends: { channel: string; data: unknown }[] = []
  let destroyed = false
  const ee = new EventEmitter()
  const wc = {
    isDestroyed: () => destroyed,
    send: (channel: string, data: unknown) => sends.push({ channel, data }),
    once: (event: string, cb: () => void) => {
      ee.once(event, cb)
    }
  } as unknown as Electron.WebContents
  return {
    wc,
    sends,
    destroy: () => {
      destroyed = true
      ee.emit('destroyed')
    }
  }
}

interface CapturedCall {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
}
const captured: CapturedCall[] = []

interface AliasCall {
  distinctId: string
  alias: string
}
const aliases: AliasCall[] = []

interface IdentifyCall {
  distinctId: string
  properties?: { $set?: Record<string, unknown> }
}
const identifies: IdentifyCall[] = []

interface ExceptionCall {
  error: unknown
  distinctId: string
  properties?: Record<string, unknown>
}
const exceptions: ExceptionCall[] = []

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(call: CapturedCall): void {
      captured.push(call)
    }
    identify(call: IdentifyCall): void {
      identifies.push(call)
    }
    captureException(
      error: unknown,
      distinctId: string,
      properties?: Record<string, unknown>
    ): void {
      exceptions.push({ error, distinctId, properties })
    }
    alias(call: AliasCall): void {
      aliases.push(call)
    }
    aliasImmediate(call: AliasCall): Promise<void> {
      aliases.push(call)
      return Promise.resolve()
    }
    flush(): Promise<void> {
      return Promise.resolve()
    }
    shutdown(): Promise<void> {
      return Promise.resolve()
    }
    getFeatureFlag(): Promise<undefined> {
      return Promise.resolve(undefined)
    }
  }
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
  // extended vocabulary
  it('classifies CUDA / system / Linux OOM-killer as oom', () => {
    expect(telemetry.bucketError('CUDA out of memory')).toBe('oom')
    expect(telemetry.bucketError('torch.cuda.OutOfMemoryError: blah')).toBe('oom')
    expect(telemetry.bucketError('Killed: process exceeded memory')).toBe('oom')
  })
  it('classifies CUDA init failures', () => {
    expect(telemetry.bucketError('CUDA not available')).toBe('cuda_init')
    expect(telemetry.bucketError('no CUDA-capable device is detected')).toBe('cuda_init')
  })
  it('classifies ImportError / ModuleNotFoundError', () => {
    expect(telemetry.bucketError('ImportError: cannot import name xformers')).toBe('import_error')
    expect(telemetry.bucketError('ModuleNotFoundError: No module named foo')).toBe('import_error')
  })
  it('classifies custom-node-missing', () => {
    expect(telemetry.bucketError('node not found: SomeCustomNode')).toBe('node_missing')
    expect(telemetry.bucketError('Unknown node type FooNode')).toBe('node_missing')
  })
  it('falls back to "python" for generic <Class>Error messages', () => {
    expect(telemetry.bucketError('RuntimeError: something broke')).toBe('python')
    expect(telemetry.bucketError('ValueError: bad input')).toBe('python')
  })
  it('falls back to "python" even when the class is mid-message (no ^ anchor)', () => {
    // scrubAll can strip a leading path and leave the class name in the
    // middle; previously the `^`-anchored regex would miss this and the
    // event landed in `other`.
    expect(telemetry.bucketError('execution failed -> RuntimeError: bad input')).toBe('python')
    expect(telemetry.bucketError('Got AttributeError while computing')).toBe('python')
  })
  it('does NOT false-positive on lowercase noise like "module.error"', () => {
    // The python regex requires an uppercase first letter on the class
    // name — without that, "user.error: oops" or "config.exception in foo"
    // would slide into the python bucket and pollute the dashboard.
    expect(telemetry.bucketError('see module.error somewhere in foo.py')).toBe('other')
    expect(telemetry.bucketError('the user.exception field is set')).toBe('other')
  })
  it('classifies tensor / shape mismatches', () => {
    expect(telemetry.bucketError('size mismatch for transformer.h.0.weight')).toBe('shape_mismatch')
    expect(telemetry.bucketError("shape '[1, 4, 64, 64]' is invalid for input of size 16384")).toBe(
      'shape_mismatch'
    )
    expect(telemetry.bucketError('expected 4 dimensions but got 3')).toBe('shape_mismatch')
  })
  it('classifies model-load failures', () => {
    expect(telemetry.bucketError('Error while deserializing header: invalid byte 0x12')).toBe(
      'model_load'
    )
    expect(telemetry.bucketError('Missing key(s) in state_dict: "transformer.h.0.weight"')).toBe(
      'model_load'
    )
    expect(telemetry.bucketError('safetensors_rust.SafetensorError: corrupted')).toBe('model_load')
  })
  it('classifies workflow-validation failures', () => {
    expect(telemetry.bucketError('Prompt outputs failed validation')).toBe('validation')
    expect(telemetry.bucketError('validation_failed for node 5')).toBe('validation')
  })
  it('keeps "other" for messages with no known signal', () => {
    expect(telemetry.bucketError('this is just a sentence')).toBe('other')
  })
})

describe('telemetry default event properties', () => {
  beforeEach(() => {
    captured.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry._resetForTest()
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    telemetry._resetForTest()
  })

  it('injects app_version, app_channel, app_env, platform, arch on every capture', () => {
    telemetry.initTelemetry({ appVersion: '0.7.0-beta.3', appEnv: 'prod', isPackaged: true })
    telemetry.identify('id')
    telemetry.setConsentState('granted')
    captured.length = 0

    telemetry.capture('desktop2.test.event', { foo: 'bar' })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.properties).toMatchObject({
      foo: 'bar',
      app_version: '0.7.0-beta.3',
      app_channel: 'beta',
      app_env: 'prod',
      is_packaged: true,
      platform: process.platform,
      arch: process.arch
    })
  })

  it('derives stable channel for a clean semver and unknown for an unfamiliar suffix', () => {
    telemetry.initTelemetry({ appVersion: '1.0.0', appEnv: 'prod', isPackaged: true })
    telemetry.identify('id')
    telemetry.setConsentState('granted')
    captured.length = 0
    telemetry.capture('any.event')
    expect(captured[0]!.properties).toMatchObject({ app_channel: 'stable' })

    telemetry._resetForTest()
    telemetry.initTelemetry({ appVersion: '1.0.0-rc.1', appEnv: 'prod', isPackaged: true })
    telemetry.identify('id')
    telemetry.setConsentState('granted')
    captured.length = 0
    telemetry.capture('any.event')
    expect(captured[0]!.properties).toMatchObject({ app_channel: 'unknown' })
  })

  it('per-call properties override defaults on key collision', () => {
    telemetry.initTelemetry({ appVersion: '1.0.0', appEnv: 'prod', isPackaged: true })
    telemetry.identify('id')
    telemetry.setConsentState('granted')
    captured.length = 0

    telemetry.capture('any.event', { app_version: 'override-value' })
    expect(captured[0]!.properties).toMatchObject({ app_version: 'override-value' })
  })
})

describe('telemetry.trackedStep', () => {
  beforeEach(async () => {
    captured.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
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
    expect(captured[0]!.properties).toMatchObject({ foo: 'bar' })
    expect(typeof captured[1]!.properties?.duration_ms).toBe('number')
    expect(captured[1]!.properties?.foo).toBe('bar')
  })

  it('emits .start and .error on failure and rethrows', async () => {
    captured.length = 0
    await expect(
      telemetry.trackedStep('install.step', { id: 'x' }, async () => {
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')
    const events = captured.map((c) => c.event)
    expect(events).toEqual(['install.step.start', 'install.step.error'])
    expect(captured[1]!.properties).toMatchObject({
      id: 'x',
      error_bucket: 'disk',
      error_message: 'disk full'
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

describe('telemetry consent state (3-state)', () => {
  beforeEach(async () => {
    captured.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    // Reset module state so each test starts with fresh pendingSessionStart etc.
    telemetry._resetForTest()
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
    // identify *after* state changes per test so the deferral path is exercised.
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    // Reset to granted so other test blocks behave like the legacy default.
    telemetry.setConsentState('granted')
  })

  it('undecided suppresses regular events but allows the consent_decision event', async () => {
    telemetry.setConsentState('undecided')
    telemetry.identify('test-distinct-id')
    captured.length = 0

    telemetry.capture('desktop2.execution.started', { foo: 'bar' })
    telemetry.capture('desktop2.first_use.consent_decision', { accepted: false })

    const events = captured.map((c) => c.event)
    expect(events).toEqual(['desktop2.first_use.consent_decision'])
  })

  it('denied suppresses everything EXCEPT the consent_decision allow-list entry', async () => {
    // Regression for the 2026-06-03 finding: 232 accepts and 0 declines in
    // 30 days, traced to the renderer's "Continue" handler awaiting the
    // setting write (which flips state to 'denied') BEFORE emitting the
    // decline event. If denied short-circuits without consulting the
    // allow-list, every decline is dropped by its own decision and we
    // lose 100% of decline signal.
    telemetry.setConsentState('denied')
    telemetry.identify('test-distinct-id')
    captured.length = 0

    telemetry.capture('desktop2.execution.started', {})
    telemetry.capture('desktop2.first_use.consent_decision', {
      decision: 'decline',
      telemetry_enabled: false
    })

    expect(captured.map((c) => c.event)).toEqual(['desktop2.first_use.consent_decision'])
    expect(captured[0]?.properties).toMatchObject({
      decision: 'decline',
      telemetry_enabled: false
    })
  })

  it('defers session.started + identify person properties until consent flips to granted', async () => {
    telemetry.setConsentState('undecided')
    telemetry.identify('deferred-id', { app_version: '1.2.3' })

    // Nothing should have shipped yet — neither the identify nor session.started.
    expect(captured).toHaveLength(0)

    telemetry.setConsentState('granted')

    const events = captured.map((c) => c.event)
    expect(events).toContain('desktop2.session.started')
    expect(captured.find((c) => c.event === 'desktop2.session.started')?.distinctId).toBe(
      'deferred-id'
    )
  })

  it('legacy setConsent(true) maps to granted; setConsent(false) maps to denied', () => {
    telemetry.setConsent(true)
    telemetry.identify('legacy-id')
    captured.length = 0
    telemetry.capture('any.event', {})
    expect(captured).toHaveLength(1)

    telemetry.setConsent(false)
    captured.length = 0
    telemetry.capture('any.event', {})
    expect(captured).toHaveLength(0)
  })

  it('aliasImmediate is suppressed outside granted', async () => {
    telemetry.setConsentState('undecided')
    telemetry.identify('any')
    aliases.length = 0
    await telemetry.aliasImmediate('new', 'legacy')
    expect(aliases).toHaveLength(0)

    telemetry.setConsentState('denied')
    aliases.length = 0
    await telemetry.aliasImmediate('new', 'legacy')
    expect(aliases).toHaveLength(0)

    // Sanity: granted DOES alias.
    telemetry.setConsentState('granted')
    aliases.length = 0
    await telemetry.aliasImmediate('new', 'legacy')
    expect(aliases).toHaveLength(1)
  })

  it('captureException is suppressed outside granted', () => {
    telemetry.setConsentState('denied')
    telemetry.identify('any')
    exceptions.length = 0
    telemetry.captureException(new Error('boom'), {})
    expect(exceptions).toHaveLength(0)

    telemetry.setConsentState('undecided')
    exceptions.length = 0
    telemetry.captureException(new Error('boom'), {})
    expect(exceptions).toHaveLength(0)

    // Sanity: granted DOES capture.
    telemetry.setConsentState('granted')
    exceptions.length = 0
    telemetry.captureException(new Error('boom'), {})
    expect(exceptions).toHaveLength(1)
  })
})

describe('telemetry.registerPersonProperties pre-consent merge', () => {
  beforeEach(() => {
    captured.length = 0
    identifies.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry._resetForTest()
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    telemetry.setConsentState('granted')
  })

  it('merges multiple pre-consent property writes into one identify on grant (latest-wins per key)', () => {
    telemetry.setConsentState('undecided')
    telemetry.identify('id', { app_version: '1.0.0' })
    identifies.length = 0

    telemetry.registerPersonProperties({ gpu_tier: 'low', locale: 'en' })
    telemetry.registerPersonProperties({ gpu_tier: 'mid', theme: 'dark' })
    // Nothing should have shipped yet.
    expect(identifies).toHaveLength(0)

    telemetry.setConsentState('granted')

    // Exactly one identify call carrying the merged $set, with the
    // second gpu_tier value winning over the first.
    const merged = identifies.find(
      (i) => i.properties?.$set && 'gpu_tier' in (i.properties.$set as Record<string, unknown>)
    )
    expect(merged?.properties?.$set).toMatchObject({
      app_version: '1.0.0',
      gpu_tier: 'mid',
      locale: 'en',
      theme: 'dark'
    })
  })
})

describe('telemetry deferMigrationAlias', () => {
  beforeEach(() => {
    captured.length = 0
    aliases.length = 0
    identifies.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry._resetForTest()
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
    telemetry.setConsentState('granted')
  })

  it('fires alias + identity.migrated immediately when consent already granted', async () => {
    telemetry.setConsentState('granted')
    telemetry.identify('new-id')
    aliases.length = 0
    captured.length = 0

    const onAliased = vi.fn()
    telemetry.deferMigrationAlias({
      legacyId: 'legacy-uuid-abc',
      installationId: 'new-id',
      idClass: 'machine_derived',
      onAliased
    })

    // Async microtask + the aliasImmediate await chain.
    await new Promise((r) => setTimeout(r, 0))

    expect(aliases).toContainEqual({ distinctId: 'new-id', alias: 'legacy-uuid-abc' })
    const migrated = captured.find((c) => c.event === 'desktop2.identity.migrated')
    expect(migrated?.properties).toMatchObject({
      installation_id: 'new-id',
      id_class: 'machine_derived'
    })
    // Privacy hygiene: the legacy id is intentionally NOT shipped as an
    // event property — the alias call above already merges the person
    // records, so re-publishing the legacy id would scatter it across
    // the events column for no analytical benefit.
    expect(migrated?.properties).not.toHaveProperty('from_id')
    expect(onAliased).toHaveBeenCalledTimes(1)
  })

  it('defers until consent flips to granted (undecided → granted)', async () => {
    telemetry.setConsentState('undecided')
    telemetry.identify('new-id')
    aliases.length = 0
    captured.length = 0

    const onAliased = vi.fn()
    telemetry.deferMigrationAlias({
      legacyId: 'legacy-uuid-abc',
      installationId: 'new-id',
      idClass: 'machine_derived',
      onAliased
    })

    // Nothing should have shipped while undecided.
    await new Promise((r) => setTimeout(r, 0))
    expect(aliases).toHaveLength(0)
    expect(captured.find((c) => c.event === 'desktop2.identity.migrated')).toBeUndefined()
    expect(onAliased).not.toHaveBeenCalled()

    telemetry.setConsentState('granted')
    await new Promise((r) => setTimeout(r, 0))

    expect(aliases).toContainEqual({ distinctId: 'new-id', alias: 'legacy-uuid-abc' })
    expect(captured.find((c) => c.event === 'desktop2.identity.migrated')).toBeDefined()
    expect(onAliased).toHaveBeenCalledTimes(1)
  })

  it('does not fire onAliased while denied; fires on subsequent grant', async () => {
    telemetry.setConsentState('denied')
    telemetry.identify('new-id')
    aliases.length = 0
    captured.length = 0

    const onAliased = vi.fn()
    telemetry.deferMigrationAlias({
      legacyId: 'legacy-uuid-abc',
      installationId: 'new-id',
      idClass: 'machine_derived',
      onAliased
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(aliases).toHaveLength(0)
    expect(onAliased).not.toHaveBeenCalled()

    telemetry.setConsentState('granted')
    await new Promise((r) => setTimeout(r, 0))

    expect(aliases).toHaveLength(1)
    expect(onAliased).toHaveBeenCalledTimes(1)
  })

  it('does not double-fire on repeated grant transitions', async () => {
    telemetry.setConsentState('undecided')
    telemetry.identify('new-id')
    aliases.length = 0
    const onAliased = vi.fn()
    telemetry.deferMigrationAlias({
      legacyId: 'legacy-uuid-abc',
      installationId: 'new-id',
      idClass: 'machine_derived',
      onAliased
    })

    telemetry.setConsentState('granted')
    await new Promise((r) => setTimeout(r, 0))
    telemetry.setConsentState('denied')
    telemetry.setConsentState('granted')
    await new Promise((r) => setTimeout(r, 0))

    expect(aliases).toHaveLength(1)
    expect(onAliased).toHaveBeenCalledTimes(1)
  })
})

describe('telemetry identity lifecycle (bindUserId / unbindUserId)', () => {
  beforeEach(() => {
    captured.length = 0
    aliases.length = 0
    identifies.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry._resetForTest()
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
    telemetry.setConsentState('granted')
    telemetry.identify('installation-id-fake')
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
  })

  it('bindUserId aliases the installation_id into the user_id and fires app:user_logged_in', () => {
    aliases.length = 0
    identifies.length = 0
    captured.length = 0

    telemetry.bindUserId('user-123', { email_domain: 'example.com' })

    expect(aliases).toEqual([{ distinctId: 'user-123', alias: 'installation-id-fake' }])
    const last = identifies.at(-1)!
    expect(last.distinctId).toBe('user-123')
    expect(last.properties?.$set).toMatchObject({
      is_authenticated: true,
      email_domain: 'example.com'
    })
    expect(captured.find((c) => c.event === 'app:user_logged_in')?.distinctId).toBe('user-123')
  })

  it('unbindUserId switches distinct_id back to the installation_id (NOT a reset)', () => {
    telemetry.bindUserId('user-123')
    aliases.length = 0
    identifies.length = 0
    captured.length = 0

    telemetry.unbindUserId()

    // No new alias call on logout (we're not merging anything).
    expect(aliases).toHaveLength(0)
    // is_authenticated flipped to false on the anonymous identity.
    const last = identifies.at(-1)!
    expect(last.distinctId).toBe('installation-id-fake')
    expect(last.properties?.$set).toEqual({ is_authenticated: false })

    // Subsequent events ride under the installation id again.
    telemetry.capture('any.event', { foo: 1 })
    expect(captured.at(-1)?.distinctId).toBe('installation-id-fake')
  })

  it('bindUserId is suppressed outside consent granted', () => {
    telemetry.setConsentState('denied')
    aliases.length = 0
    identifies.length = 0
    captured.length = 0
    telemetry.bindUserId('user-456')
    expect(aliases).toHaveLength(0)
    expect(identifies).toHaveLength(0)
    expect(captured).toHaveLength(0)
  })
})

describe('telemetry.forwardToRenderer + telemetry-relay registry', () => {
  beforeEach(async () => {
    telemetry._resetTelemetryRelayTargets()
    captured.length = 0
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
    await telemetry.identify('test-distinct-id')
    telemetry.setConsent(true)
  })

  afterEach(() => {
    telemetry._resetTelemetryRelayTargets()
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
  })

  it('forwards to every registered relay target with mainAlreadyCaptured=true', () => {
    const a = makeStubWebContents()
    const b = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)
    telemetry.registerTelemetryRelayTarget(b.wc)

    telemetry.forwardToRenderer('desktop2.execution.error', { foo: 'bar' })

    expect(a.sends).toHaveLength(1)
    expect(a.sends[0]).toMatchObject({
      channel: 'telemetry-action-from-main',
      data: {
        event: 'desktop2.execution.error',
        context: { foo: 'bar' },
        mainAlreadyCaptured: true
      }
    })
    expect(b.sends).toHaveLength(1)
    expect(b.sends[0]).toMatchObject({
      data: { mainAlreadyCaptured: true }
    })
  })

  it('emit() captures via PostHog Node AND forwards to relay targets', () => {
    const a = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)

    // Use a name that is in the Datadog allow-list so the forward path runs.
    telemetry.emit('desktop2.execution.error', { variant: 'standalone' })

    // PostHog Node side
    expect(captured.map((c) => c.event)).toEqual(['desktop2.execution.error'])
    expect(captured[0]!.properties).toMatchObject({ variant: 'standalone' })
    // Relay side — exactly one IPC send to the registered target
    expect(a.sends).toHaveLength(1)
    expect(a.sends[0]).toMatchObject({
      channel: 'telemetry-action-from-main',
      data: {
        event: 'desktop2.execution.error',
        context: { variant: 'standalone' },
        mainAlreadyCaptured: true
      }
    })
  })

  it('forwards with no relay targets is a no-op (event still captured by PostHog Node)', () => {
    expect(telemetry._telemetryRelayTargetCount()).toBe(0)
    // Use a name in the Datadog allow-list so the forward path actually fires.
    telemetry.emit('desktop2.execution.error', {})
    // Event still captured by PostHog Node even with no renderer alive yet —
    // the architectural guarantee that "telemetry works no matter what".
    expect(captured.map((c) => c.event)).toEqual(['desktop2.execution.error'])
  })

  it('skips forwarding for events NOT in the Datadog mirror allow-list (provider split)', () => {
    const a = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)

    // Product / funnel events stay PostHog-only and do not ride the relay.
    telemetry.emit('desktop2.install.flow.opened', { variant: 'standalone' })

    // PostHog Node still captured it.
    expect(captured.map((c) => c.event)).toEqual(['desktop2.install.flow.opened'])
    // But the renderer never sees it — no Datadog mirror needed for a product event.
    expect(a.sends).toHaveLength(0)
  })

  it('respects consent on forwardToRenderer: relay is skipped when revoked', () => {
    const a = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)
    telemetry.setConsent(false)
    telemetry.forwardToRenderer('desktop2.execution.error', {})
    expect(a.sends).toHaveLength(0)
    telemetry.setConsent(true)
  })

  it('skips destroyed relay targets', () => {
    const a = makeStubWebContents()
    const b = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)
    telemetry.registerTelemetryRelayTarget(b.wc)
    a.destroy()

    telemetry.forwardToRenderer('desktop2.execution.error', {})

    expect(a.sends).toHaveLength(0)
    expect(b.sends).toHaveLength(1)
  })

  it('auto-removes relay targets on the WebContents `destroyed` event', () => {
    const a = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)
    expect(telemetry._telemetryRelayTargetCount()).toBe(1)

    a.destroy()
    expect(telemetry._telemetryRelayTargetCount()).toBe(0)
  })

  it('unregisterTelemetryRelayTarget removes the target', () => {
    const a = makeStubWebContents()
    telemetry.registerTelemetryRelayTarget(a.wc)
    expect(telemetry._telemetryRelayTargetCount()).toBe(1)

    telemetry.unregisterTelemetryRelayTarget(a.wc)
    expect(telemetry._telemetryRelayTargetCount()).toBe(0)

    telemetry.forwardToRenderer('desktop2.execution.error', {})
    expect(a.sends).toHaveLength(0)
  })
})

describe('telemetry SDK-level volume guards', () => {
  beforeEach(async () => {
    process.env['POSTHOG_API_KEY'] = 'test-key'
    process.env['POSTHOG_ENABLED'] = '1'
    telemetry.initTelemetry({ appVersion: '0.0.0', appEnv: 'test', isPackaged: true })
    await telemetry.identify('test-distinct-id')
    telemetry.setConsent(true)
    telemetry._test_resetVolumeGuards()
    // Clear AFTER setConsent — granting consent flushes the deferred
    // `desktop2.session.started` event into `captured`, which would
    // otherwise count toward each test's product-event totals and
    // throw the per-process cap assertions off by one (and make the
    // 5000-cap test loop runaway-guard out, eating the 5s timeout).
    captured.length = 0
  })

  afterEach(() => {
    delete process.env['POSTHOG_API_KEY']
    delete process.env['POSTHOG_ENABLED']
  })

  it('per-event sliding window caps at 60/window and emits exactly one rate_limited warning', () => {
    for (let i = 0; i < 100; i++) {
      telemetry.capture('desktop2.test.event', { i })
    }
    const product = captured.filter((c) => c.event === 'desktop2.test.event')
    const warnings = captured.filter((c) => c.event === 'desktop2.telemetry.rate_limited')
    expect(product).toHaveLength(60)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.properties).toMatchObject({
      event_name: 'desktop2.test.event',
      limit: 60,
      window_ms: 60_000
    })
  })

  it('warning fires once per (event-name, process) — no warning spam', () => {
    for (let i = 0; i < 200; i++) {
      telemetry.capture('desktop2.test.event', { i })
    }
    const warnings = captured.filter((c) => c.event === 'desktop2.telemetry.rate_limited')
    expect(warnings).toHaveLength(1)
  })

  it('different event names have independent windows', () => {
    for (let i = 0; i < 100; i++) {
      telemetry.capture('desktop2.test.a', { i })
      telemetry.capture('desktop2.test.b', { i })
    }
    const a = captured.filter((c) => c.event === 'desktop2.test.a')
    const b = captured.filter((c) => c.event === 'desktop2.test.b')
    expect(a).toHaveLength(60)
    expect(b).toHaveLength(60)
  })

  it('*.error events bypass the per-event rate limit', () => {
    for (let i = 0; i < 200; i++) {
      telemetry.capture('desktop2.execution.error', { i })
    }
    const errors = captured.filter((c) => c.event === 'desktop2.execution.error')
    expect(errors).toHaveLength(200)
    const warnings = captured.filter((c) => c.event === 'desktop2.telemetry.rate_limited')
    expect(warnings).toHaveLength(0)
  })

  it('telemetry-self events bypass the rate limit (no recursion when warning fires)', () => {
    for (let i = 0; i < 200; i++) {
      telemetry.capture('desktop2.telemetry.rate_limited', { i })
    }
    const selfEvents = captured.filter((c) => c.event === 'desktop2.telemetry.rate_limited')
    expect(selfEvents).toHaveLength(200)
  })

  it('per-process cap at 5000 stops everything (including *.error) and warns once', () => {
    // Fire enough rate-limited-bypassing errors to overshoot the 5000
    // session cap by a healthy margin — the cap is the FINAL backstop
    // and must apply even to events that bypass the per-event window.
    // Use a fixed iteration count instead of polling `captured.filter()`
    // each loop turn: that filter is O(N) over a growing array, so a
    // while-condition variant is O(N²) and blows the 5s test timeout
    // on slower CI hosts.
    for (let i = 0; i < 6000; i++) {
      telemetry.capture('desktop2.execution.error', { i })
    }
    const productEvents = captured.filter((c) => c.event !== 'desktop2.telemetry.session_cap_hit')
    const sessionCapWarnings = captured.filter(
      (c) => c.event === 'desktop2.telemetry.session_cap_hit'
    )
    expect(productEvents).toHaveLength(5000)
    expect(sessionCapWarnings).toHaveLength(1)
    expect(sessionCapWarnings[0]?.properties).toMatchObject({ cap: 5000 })
  })
})
