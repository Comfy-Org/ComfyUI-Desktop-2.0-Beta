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

const { createExecutionTap } = await import('./executionTap')
const telemetry = await import('./telemetry')

describe('executionTap', () => {
  let captured: Array<{ event: string; ctx: Record<string, unknown> }>

  beforeEach(() => {
    captured = []
    vi.spyOn(telemetry, 'emit').mockImplementation((event, ctx) => {
      captured.push({ event, ctx: ctx as Record<string, unknown> })
    })
    vi.spyOn(telemetry, 'getFlag').mockImplementation((name: string, fallback?: unknown) => {
      if (name === 'launcher.execution_telemetry.enabled') return true
      if (name === 'launcher.execution_telemetry.sample_rate') return 1
      return fallback
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits started when "got prompt" appears in stdout', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got prompt\n', 'stdout')
    expect(captured.map((c) => c.event)).toEqual(['launcher.execution.started'])
    expect(captured[0]!.ctx).toMatchObject({ installation_id: 'inst-1', started_count: 1 })
  })

  it('emits completed with parsed duration_seconds', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got prompt\nPrompt executed in 12.5 seconds\n', 'stdout')
    const completed = captured.find((c) => c.event === 'launcher.execution.completed')
    expect(completed).toBeDefined()
    expect(completed!.ctx).toMatchObject({
      installation_id: 'inst-1',
      duration_seconds: 12.5,
      completed_count: 1,
    })
  })

  it('emits validation_failed errors when prompt validation fails', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('Failed to validate prompt for output 42:\n', 'stdout')
    const err = captured.find((c) => c.event === 'launcher.execution.error')
    expect(err).toBeDefined()
    expect(err!.ctx).toMatchObject({ error_class: 'validation_failed', node_id: '42' })
  })

  it('captures Python tracebacks from stderr and emits a single error', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest(
      [
        'Traceback (most recent call last):',
        '  File "main.py", line 10, in <module>',
        '    raise RuntimeError("boom")',
        'RuntimeError: boom',
        '',
      ].join('\n'),
      'stderr',
    )
    const errs = captured.filter((c) => c.event === 'launcher.execution.error')
    expect(errs.length).toBe(1)
    expect(errs[0]!.ctx).toMatchObject({ error_class: 'RuntimeError' })
  })

  it('emits a session_summary on flush even when nothing was captured', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.flushSummary()
    const summary = captured.find((c) => c.event === 'launcher.execution.session_summary')
    expect(summary).toBeDefined()
    expect(summary!.ctx).toMatchObject({
      installation_id: 'inst-1',
      started_count: 0,
      completed_count: 0,
      error_count: 0,
    })
  })

  it('respects the kill switch feature flag', () => {
    vi.spyOn(telemetry, 'getFlag').mockImplementation((name: string, fallback?: unknown) => {
      if (name === 'launcher.execution_telemetry.enabled') return false
      return fallback
    })
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got prompt\nPrompt executed in 1 seconds\n', 'stdout')
    tap.flushSummary()
    expect(captured.length).toBe(0)
  })

  it('handles split chunks at line boundaries', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got pro', 'stdout')
    tap.ingest('mpt\nPrompt executed in 2 seconds\n', 'stdout')
    const events = captured.map((c) => c.event)
    expect(events).toContain('launcher.execution.started')
    expect(events).toContain('launcher.execution.completed')
  })
})
