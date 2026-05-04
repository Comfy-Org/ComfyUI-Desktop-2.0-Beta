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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits started when "got prompt" appears in stdout', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got prompt\n', 'stdout')
    expect(captured.map((c) => c.event)).toEqual(['desktop2.execution.started'])
    expect(captured[0]!.ctx).toMatchObject({ installation_id: 'inst-1', started_count: 1 })
  })

  it('emits completed with parsed duration_seconds', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got prompt\nPrompt executed in 12.5 seconds\n', 'stdout')
    const completed = captured.find((c) => c.event === 'desktop2.execution.completed')
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
    const err = captured.find((c) => c.event === 'desktop2.execution.error')
    expect(err).toBeDefined()
    expect(err!.ctx).toMatchObject({ error_class: 'validation_failed', node_id: '42' })
  })

  it('captures Python tracebacks from stderr and emits a single error', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    // Trailing line after the blank-line boundary so the parser sees the
    // boundary as a complete line (mirrors real ComfyUI output where logs
    // continue after a failure).
    tap.ingest(
      [
        'Traceback (most recent call last):',
        '  File "main.py", line 10, in <module>',
        '    raise RuntimeError("boom")',
        'RuntimeError: boom',
        '',
        'next-line',
      ].join('\n'),
      'stderr',
    )
    const errs = captured.filter((c) => c.event === 'desktop2.execution.error')
    expect(errs.length).toBe(1)
    expect(errs[0]!.ctx).toMatchObject({ error_class: 'RuntimeError' })
  })

  it('emits one error per traceback in chained Python tracebacks', () => {
    // We deliberately do NOT collapse chained tracebacks; the inner and the
    // outer are real distinct errors and analytics needs both visible.
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest(
      [
        'Traceback (most recent call last):',
        '  File "a.py", line 1, in <module>',
        '    raise ValueError("inner")',
        'ValueError: inner',
        '',
        'During handling of the above exception, another exception occurred:',
        '',
        'Traceback (most recent call last):',
        '  File "b.py", line 2, in <module>',
        '    raise RuntimeError("outer")',
        'RuntimeError: outer',
        '',
        'next-line',
      ].join('\n'),
      'stderr',
    )
    const errs = captured.filter((c) => c.event === 'desktop2.execution.error')
    const classes = errs.map((e) => e.ctx['error_class'])
    expect(classes).toEqual(['ValueError', 'RuntimeError'])
  })

  it('scrubs PII (Windows user paths) from traceback error messages', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest(
      [
        'Traceback (most recent call last):',
        '  File "C:\\Users\\alice\\stuff.py", line 10, in foo',
        '    open("bad")',
        'FileNotFoundError: [Errno 2] No such file: \'C:\\Users\\alice\\bad\'',
        '',
        'next-line',
      ].join('\n'),
      'stderr',
    )
    const errs = captured.filter((c) => c.event === 'desktop2.execution.error')
    expect(errs.length).toBe(1)
    const message = String(errs[0]!.ctx.error_message)
    expect(message).not.toContain('alice')
    expect(message).toContain('[REDACTED]')
  })

  it('flushSummary drains a pending traceback so errors are not lost on exit', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    // No trailing blank line — process died before traceback ended.
    tap.ingest(
      [
        'Traceback (most recent call last):',
        '  File "x.py", line 9, in y',
        'KeyError: missing',
      ].join('\n') + '\n',
      'stderr',
    )
    // Without flush, no error emitted yet (no blank-line boundary).
    expect(captured.filter((c) => c.event === 'desktop2.execution.error')).toHaveLength(0)
    tap.flushSummary()
    expect(captured.filter((c) => c.event === 'desktop2.execution.error')).toHaveLength(1)
    expect(captured.filter((c) => c.event === 'desktop2.execution.session_summary')).toHaveLength(1)
  })

  it('caps promptStartTimes so unpaired starts cannot grow unbounded', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    // Far more than the cap (256).
    for (let i = 0; i < 1000; i++) tap.ingest('got prompt\n', 'stdout')
    // Then complete one — wall_clock_ms should still be a finite number.
    tap.ingest('Prompt executed in 1 seconds\n', 'stdout')
    const completed = captured.find((c) => c.event === 'desktop2.execution.completed')
    expect(completed).toBeDefined()
    expect(typeof completed!.ctx.wall_clock_ms).toBe('number')
  })

  it('emits a session_summary on flush even when nothing was captured', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.flushSummary()
    const summary = captured.find((c) => c.event === 'desktop2.execution.session_summary')
    expect(summary).toBeDefined()
    expect(summary!.ctx).toMatchObject({
      installation_id: 'inst-1',
      started_count: 0,
      completed_count: 0,
      error_count: 0,
    })
  })

  it('handles split chunks at line boundaries', () => {
    const tap = createExecutionTap({ installationId: 'inst-1' })
    tap.ingest('got pro', 'stdout')
    tap.ingest('mpt\nPrompt executed in 2 seconds\n', 'stdout')
    const events = captured.map((c) => c.event)
    expect(events).toContain('desktop2.execution.started')
    expect(events).toContain('desktop2.execution.completed')
  })

  it('redacts Bearer tokens and api keys from traceback messages (secret scrub)', () => {
    const bearer = 'Bearer ' + 'a'.repeat(30)
    const apiKey = 's' + 'k-' + 'a'.repeat(24)
    const tap = createExecutionTap({ installationId: 'inst-1' })
    const tracebackLines = [
      'Traceback (most recent call last):',
      '  File ' + JSON.stringify('x.py') + ', line 1, in <module>',
      '    raise RuntimeError(' + JSON.stringify(bearer + ' was rejected, ' + apiKey + ' also bad') + ')',
      'RuntimeError: ' + bearer + ' was rejected, ' + apiKey + ' also bad',
      '',
      'next-line',
    ]
    tap.ingest(tracebackLines.join('\n'), 'stderr')
    const err = captured.find((c) => c.event === 'desktop2.execution.error')
    expect(err).toBeDefined()
    const msg = String(err!.ctx['error_message'])
    expect(msg).toContain('Bearer ' + '[' + 'REDACTED' + ']')
    expect(msg).not.toContain('a'.repeat(30))
    expect(msg).not.toContain(apiKey)
    expect(msg).toContain('[' + 'REDACTED' + ']')
  })

})
