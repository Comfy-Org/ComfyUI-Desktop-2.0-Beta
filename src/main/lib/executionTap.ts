/**
 * Execution telemetry tap.
 *
 * The launcher does not embed the ComfyUI frontend, so we can't IPC-forward
 * `execution_*` events the way legacy desktop did. Instead we tail ComfyUI's
 * own stdout/stderr — a stable signal that is already piped through
 * `proc.stdout` / `proc.stderr` in `sessionActions/launch.ts`.
 *
 * Patterns we detect (current ComfyUI main branch):
 *   - "got prompt"                    → execution started
 *   - "Prompt executed in X.X seconds"→ execution completed (with duration)
 *   - "Failed to validate prompt"     → validation error
 *   - Python tracebacks               → execution error
 *
 * The per-install `firstRunAt` flag mirrors legacy desktop's once-ever
 * `execution:completed` semantic. It is set on the first successful prompt
 * and emitted as `launcher.execution.first_completed`.
 *
 * All emissions are gated by the `launcher.execution_telemetry.enabled` and
 * `launcher.execution_telemetry.sample_rate` feature flags.
 */
import * as installationsApi from '../installations'
import * as telemetry from './telemetry'

interface TapState {
  installationId: string
  variant: string | null
  release: string | null
  promptStartTimes: Date[]
  startedCount: number
  completedCount: number
  errorCount: number
  // Buffer for the current stderr traceback (collected line-by-line)
  tracebackBuffer: string[]
  inTraceback: boolean
  // Re-uses one shared sample bucket across started/completed/error so a
  // sampled-out prompt is dropped consistently.
  sampleDropped: number
}

const TRACEBACK_START = /^Traceback \(most recent call last\):/
const PROMPT_GOT = /^got prompt/i
const PROMPT_DONE = /^Prompt executed in (?<seconds>\d+(?:\.\d+)?)\s*seconds?\s*$/i
const VALIDATION_FAIL = /^Failed to validate prompt for output (?<nodeId>\S+):/i

export function isTelemetryEnabled(): boolean {
  return telemetry.getFlag<boolean>('launcher.execution_telemetry.enabled', true) === true
}

function shouldSample(): boolean {
  const rate = Number(telemetry.getFlag('launcher.execution_telemetry.sample_rate', 1))
  if (!Number.isFinite(rate) || rate >= 1) return true
  if (rate <= 0) return false
  return Math.random() < rate
}

export function createExecutionTap(opts: {
  installationId: string
  variant?: string | null
  release?: string | null
}): {
  ingest: (chunk: string, source: 'stdout' | 'stderr') => void
  flushSummary: () => void
} {
  const state: TapState = {
    installationId: opts.installationId,
    variant: opts.variant ?? null,
    release: opts.release ?? null,
    promptStartTimes: [],
    startedCount: 0,
    completedCount: 0,
    errorCount: 0,
    tracebackBuffer: [],
    inTraceback: false,
    sampleDropped: 0,
  }

  const baseContext = {
    installation_id: state.installationId,
    variant: state.variant,
    release: state.release,
  }

  function emitFirstCompletedIfNeeded(): void {
    if (state.completedCount !== 1) return
    void (async () => {
      try {
        const inst = await installationsApi.get(state.installationId)
        if (!inst || (inst as Record<string, unknown>)['firstRunAt']) return
        const firstRunAt = new Date().toISOString()
        await installationsApi.update(state.installationId, { firstRunAt })
        telemetry.emit('launcher.execution.first_completed', {
          ...baseContext,
          first_run_at: firstRunAt,
        })
      } catch {
        // ignore – telemetry side effect, not user-visible
      }
    })()
  }

  function handleLine(line: string, source: 'stdout' | 'stderr'): void {
    if (!isTelemetryEnabled()) return
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    if (PROMPT_GOT.test(trimmed)) {
      if (!shouldSample()) {
        state.sampleDropped++
        return
      }
      state.startedCount++
      state.promptStartTimes.push(new Date())
      telemetry.emit('launcher.execution.started', {
        ...baseContext,
        started_count: state.startedCount,
      })
      return
    }

    const doneMatch = trimmed.match(PROMPT_DONE)
    if (doneMatch?.groups) {
      if (state.sampleDropped > 0 && state.startedCount === 0) {
        state.sampleDropped--
        return
      }
      const seconds = Number(doneMatch.groups['seconds'])
      const startedAt = state.promptStartTimes.shift()
      const wallMs = startedAt ? Date.now() - startedAt.getTime() : null
      state.completedCount++
      telemetry.emit('launcher.execution.completed', {
        ...baseContext,
        duration_seconds: Number.isFinite(seconds) ? seconds : null,
        wall_clock_ms: wallMs,
        completed_count: state.completedCount,
      })
      emitFirstCompletedIfNeeded()
      return
    }

    const validationMatch = trimmed.match(VALIDATION_FAIL)
    if (validationMatch?.groups) {
      state.errorCount++
      telemetry.emit('launcher.execution.error', {
        ...baseContext,
        error_class: 'validation_failed',
        error_count: state.errorCount,
        node_id: validationMatch.groups['nodeId'],
      })
      return
    }

    if (source === 'stderr' && TRACEBACK_START.test(trimmed)) {
      state.inTraceback = true
      state.tracebackBuffer = [trimmed]
      return
    }
    if (state.inTraceback) {
      // Collect until we hit a blank line or a non-indented, non-File line —
      // ComfyUI tracebacks usually end with the exception class line.
      state.tracebackBuffer.push(trimmed)
      const isBoundary = trimmed.length === 0 || /^[A-Za-z_][A-Za-z0-9_.]*Error\b/.test(trimmed) || /^\S+Exception\b/.test(trimmed)
      if (isBoundary && state.tracebackBuffer.length > 1) {
        const exceptionLine = state.tracebackBuffer[state.tracebackBuffer.length - 1] || 'unknown'
        const errorClass = exceptionLine.split(':')[0]?.trim() || 'unknown'
        state.errorCount++
        telemetry.emit('launcher.execution.error', {
          ...baseContext,
          error_class: errorClass.slice(0, 80),
          error_message: exceptionLine.slice(0, 500),
          error_bucket: telemetry.bucketError(exceptionLine),
          error_count: state.errorCount,
        })
        state.inTraceback = false
        state.tracebackBuffer = []
      }
    }
  }

  const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }

  return {
    ingest(chunk: string, source: 'stdout' | 'stderr'): void {
      pending[source] += chunk
      const lines = pending[source].split(/\r?\n/)
      pending[source] = lines.pop() ?? ''
      for (const line of lines) handleLine(line, source)
    },
    flushSummary(): void {
      if (!isTelemetryEnabled()) return
      // Always emit a per-session summary so analytics has a row even when
      // no individual events were emitted (e.g. when sample_rate < 1).
      telemetry.emit('launcher.execution.session_summary', {
        ...baseContext,
        started_count: state.startedCount,
        completed_count: state.completedCount,
        error_count: state.errorCount,
      })
    },
  }
}
