/**
 * Execution telemetry tap.
 *
 * The launcher does not embed the ComfyUI frontend, so we can't IPC-forward
 * `execution_*` events the way legacy desktop did. Instead we tail ComfyUI's
 * own stdout/stderr — a stable signal that is already piped through
 * `proc.stdout` / `proc.stderr` in `sessionActions/launch.ts`.
 *
 * Patterns we detect (current ComfyUI main branch):
 *   - "got prompt"                        → execution started
 *   - "Prompt executed in X.X seconds"    → execution completed (with duration)
 *   - "Failed to validate prompt"         → validation error
 *   - Python tracebacks                   → execution error
 *
 * The per-install `firstRunAt` flag mirrors legacy desktop's once-ever
 * `execution:completed` semantic. It is set on the first successful prompt
 * and emitted as `desktop2.execution.first_completed`.
 *
 * Defensive bounds:
 *   - `promptStartTimes` is capped to avoid leaking when starts and
 *     completions don't pair (e.g. crashes mid-prompt).
 *   - Traceback collection is bounded both in lines and in buffered chars.
 *   - Python "chained" tracebacks (`During handling of the above exception, …`)
 *     emit a single error event using the final exception line.
 */
import * as installationsApi from '../installations'
import * as telemetry from './telemetry'
import { scrubAll } from './piiScrub'

/**
 * Traceback collection state. We collect until a blank line follows an
 * exception line, then emit. Chained Python tracebacks (which begin with
 * `During handling of the above exception, ...` after the inner exception's
 * blank line) emit as a separate event with their own `error_class` — the
 * counts are intentionally accurate, not deduped.
 */
type TracebackPhase = 'none' | 'collecting'

interface TapState {
  installationId: string
  variant: string | null
  release: string | null
  promptStartTimes: number[]
  startedCount: number
  completedCount: number
  errorCount: number
  // Buffer for the current stderr traceback (collected line-by-line)
  tracebackBuffer: string[]
  tracebackChars: number
  tracebackPhase: TracebackPhase
}

const TRACEBACK_START = /^Traceback \(most recent call last\):/
const PROMPT_GOT = /^got prompt/i
const PROMPT_DONE = /^Prompt executed in (?<seconds>\d+(?:\.\d+)?)\s*seconds?\s*$/i
const VALIDATION_FAIL = /^Failed to validate prompt for output (?<nodeId>\S+):/i
const EXCEPTION_LINE = /^[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception|Warning|Interrupt)\b/

const MAX_PENDING_PROMPTS = 256
const MAX_TRACEBACK_LINES = 200
const MAX_TRACEBACK_CHARS = 16 * 1024
const ERROR_MESSAGE_MAX = 500
const ERROR_CLASS_MAX = 80

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
    tracebackChars: 0,
    tracebackPhase: 'none',
  }

  const baseContext = {
    installation_id: state.installationId,
    variant: state.variant,
    release: state.release,
  }

  function pushPromptStart(): void {
    state.promptStartTimes.push(Date.now())
    // Hard cap so a long-running buggy install can't grow this unbounded
    // when starts and completions don't pair.
    while (state.promptStartTimes.length > MAX_PENDING_PROMPTS) {
      state.promptStartTimes.shift()
    }
  }

  function consumePromptStart(): number | null {
    const ts = state.promptStartTimes.shift()
    return ts === undefined ? null : Date.now() - ts
  }

  function emitFirstCompletedIfNeeded(): void {
    if (state.completedCount !== 1) return
    void (async () => {
      try {
        const inst = await installationsApi.get(state.installationId)
        if (!inst || (inst as Record<string, unknown>)['firstRunAt']) return
        const firstRunAt = new Date().toISOString()
        await installationsApi.update(state.installationId, { firstRunAt })
        telemetry.emit('desktop2.execution.first_completed', {
          ...baseContext,
          first_run_at: firstRunAt,
        })
      } catch {
        // ignore – telemetry side effect, not user-visible
      }
    })()
  }

  function emitTracebackError(): void {
    if (state.tracebackBuffer.length === 0) {
      state.tracebackPhase = 'none'
      return
    }
    // The final exception line is the user-facing error in chained
    // tracebacks. Walk backwards to find the last line matching
    // EXCEPTION_LINE.
    let exceptionLine = state.tracebackBuffer[state.tracebackBuffer.length - 1] || 'unknown'
    for (let i = state.tracebackBuffer.length - 1; i >= 0; i--) {
      const candidate = state.tracebackBuffer[i]!
      if (EXCEPTION_LINE.test(candidate)) {
        exceptionLine = candidate
        break
      }
    }
    const errorClass = exceptionLine.split(':')[0]?.trim() || 'unknown'
    const scrubbedMessage = scrubAll(exceptionLine).slice(0, ERROR_MESSAGE_MAX)
    state.errorCount++
    // An error consumes a pending start so wall-clock pairing stays sane.
    consumePromptStart()
    telemetry.emit('desktop2.execution.error', {
      ...baseContext,
      error_class: errorClass.slice(0, ERROR_CLASS_MAX),
      error_message: scrubbedMessage,
      error_bucket: telemetry.bucketError(scrubbedMessage),
      error_count: state.errorCount,
    })
    state.tracebackPhase = 'none'
    state.tracebackBuffer = []
    state.tracebackChars = 0
  }

  function appendTracebackLine(line: string): void {
    state.tracebackBuffer.push(line)
    state.tracebackChars += line.length + 1
    // Bounded buffer: if the traceback is pathologically long, force-emit
    // and reset so we never accumulate forever.
    if (
      state.tracebackBuffer.length >= MAX_TRACEBACK_LINES
      || state.tracebackChars >= MAX_TRACEBACK_CHARS
    ) {
      emitTracebackError()
    }
  }

  function handleNewLine(line: string, source: 'stdout' | 'stderr'): void {
    const trimmed = line.trim()

    if (trimmed.length === 0) return

    if (PROMPT_GOT.test(trimmed)) {
      state.startedCount++
      pushPromptStart()
      telemetry.emit('desktop2.execution.started', {
        ...baseContext,
        started_count: state.startedCount,
      })
      return
    }

    const doneMatch = trimmed.match(PROMPT_DONE)
    if (doneMatch?.groups) {
      const seconds = Number(doneMatch.groups['seconds'])
      const wallMs = consumePromptStart()
      state.completedCount++
      telemetry.emit('desktop2.execution.completed', {
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
      consumePromptStart()
      telemetry.emit('desktop2.execution.error', {
        ...baseContext,
        error_class: 'validation_failed',
        error_count: state.errorCount,
        node_id: validationMatch.groups['nodeId'],
      })
      return
    }

    if (source === 'stderr' && TRACEBACK_START.test(trimmed)) {
      state.tracebackPhase = 'collecting'
      state.tracebackBuffer = [trimmed]
      state.tracebackChars = trimmed.length + 1
      return
    }
  }

  function handleLine(line: string, source: 'stdout' | 'stderr'): void {
    const trimmed = line.trim()

    // Outside a traceback: dispatch as a normal line.
    if (state.tracebackPhase === 'none') {
      handleNewLine(line, source)
      return
    }

    // Blank lines inside a traceback terminate the current frame ONLY if we
    // already have an exception line. A chained traceback's `During handling
    // of the above exception, …` marker arrives AFTER the blank line; it
    // re-enters collection on the very next non-blank line below.
    if (trimmed.length === 0) {
      const hasExceptionLine = state.tracebackBuffer.some((l) => EXCEPTION_LINE.test(l))
      if (hasExceptionLine) {
        emitTracebackError()
        return
      }
      // Blank line before any exception line — keep collecting.
      appendTracebackLine(trimmed)
      return
    }

    // A chain marker (or a fresh `Traceback (most recent call last):`)
    // following a just-emitted error re-opens collection — but only if we
    // are still considered inside a traceback. With blank-line emit above,
    // by the time we see the chain marker we've already emitted, so it
    // arrives in `phase === 'none'` and starts a brand-new collection if
    // it's a TRACEBACK_START. Plain chain markers without a fresh
    // `Traceback:` header are ignored.

    appendTracebackLine(trimmed)
    state.tracebackPhase = 'collecting'
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
      // Drain any in-flight traceback so we don't drop the error if the
      // process exited before a boundary line arrived.
      if (
        state.tracebackPhase !== 'none'
        && state.tracebackBuffer.some((l) => EXCEPTION_LINE.test(l))
      ) {
        emitTracebackError()
      }
      // Per-session summary so analytics always has a row, even if a session
      // produced no individual prompt events.
      telemetry.emit('desktop2.execution.session_summary', {
        ...baseContext,
        started_count: state.startedCount,
        completed_count: state.completedCount,
        error_count: state.errorCount,
      })
    },
  }
}
