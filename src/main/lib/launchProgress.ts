/**
 * Launch progress tracker.
 *
 * Replaces the renderer's fake timer-driven launch bar with REAL progress
 * derived from ComfyUI's stdout. It tails the same stream already piped
 * through `sessionActions/launch.ts` (line-buffered exactly like
 * `executionTap`, so CRLF and chunk-split milestones are handled) and emits
 * the data-driven "stepped" progress the install/adopt flows already use:
 *
 *   - once, up front:  sendProgress('steps', { steps })  — phase metadata
 *   - per milestone:   sendProgress(phase, { status, percent }) — phase entry
 *   - within a phase:  sendProgress(phase, { status, percent }) — live detail
 *
 * Two-level model:
 *   Level 1 (the bar)  — phase index, paced by `launchPhases` weights.
 *   Level 2 (sub-row)  — `status` carries the live detail: an "X of Y" node
 *                        count when a denominator is known, otherwise the
 *                        latest meaningful log line for streaming phases.
 *
 * The phase index is MONOTONIC: a later milestone can skip-advance past
 * intermediate phases (logs batch), but we never walk backward.
 */
import type { LaunchPhaseDef } from './launchPhases'

/** Per-node import line: `   0.0 seconds: /path/to/custom_nodes/<name>`. */
const NODE_IMPORT_LINE = /^\s*[\d.]+\s*seconds?:\s*.*[/\\]custom_nodes[/\\](.+?)[/\\]?$/i

/**
 * Translate raw startup log lines into HUMAN-readable sub-status messages.
 * We deliberately do NOT surface raw log lines (a non-technical user can't
 * parse `Using sub quadratic optimization for attention`). Only recognized
 * signals produce a message; everything else produces nothing, so the active
 * step keeps just its phase caption. First match wins — order matters.
 *
 * These keys are i18n keys under `launch.activity.*`; the renderer resolves
 * them, so the tracker stays locale-agnostic. The full raw log remains
 * available behind the existing "View Logs" control.
 */
const ACTIVITY_MESSAGES: ReadonlyArray<{ match: RegExp; key: string }> = [
  { match: /\[(?:PRE|START)\] ComfyUI-Manager|ComfyUI-Manager/i, key: 'launch.activity.manager' },
  { match: /FETCH ComfyRegistry|custom-node-list|api\.comfy\.org\/nodes/i, key: 'launch.activity.registry' },
  { match: /Set vram state|Device:\s|VRAM/i, key: 'launch.activity.vram' },
  { match: /pytorch version|optimization for attention|xformers|sage-attention|flash-attention/i, key: 'launch.activity.optimizing' },
  { match: /Checkpoint files will always|model path|Adding extra search path/i, key: 'launch.activity.models' },
  { match: /Database|alembic|Running upgrade|SQLite/i, key: 'launch.activity.database' },
  { match: /Import times for custom nodes|Loading custom node|Loaded node/i, key: 'launch.activity.nodes' },
]

/** Map a raw log line to a human i18n key, or null if it's not meaningful. */
function activityKeyFor(line: string): string | null {
  for (const entry of ACTIVITY_MESSAGES) {
    if (entry.match.test(line)) return entry.key
  }
  return null
}

export interface LaunchProgressTracker {
  /** Emit the steps payload and enter the synthetic first phase, BEFORE any
   *  stdout. Makes the launch op stepped from frame zero (no flat window /
   *  separate "Starting ComfyUI" bar). Idempotent. */
  start: () => void
  /** Feed a stdout/stderr chunk. Safe to call with partial lines. */
  ingest: (chunk: string) => void
}

export function createLaunchProgressTracker(opts: {
  phases: readonly LaunchPhaseDef[]
  /** Total custom-node count from a pre-launch scan, for "X of Y" detail.
   *  Omit/0 when unknown — `customNodes` then degrades to a streaming line. */
  nodeCount?: number
  /** Bound `makeSendProgress(sender, installationId)`. */
  sendProgress: (phase: string, detail: Record<string, unknown>) => void
}): LaunchProgressTracker {
  const { phases, sendProgress } = opts
  const nodeCount = opts.nodeCount && opts.nodeCount > 0 ? opts.nodeCount : 0

  // Index of the currently-active phase; -1 until the first milestone.
  let activeIdx = -1
  // Nodes seen so far in the customNodes phase, for the X-of-Y detail.
  let nodesSeen = 0
  let stepsSent = false
  let vramGb: number | null = null

  function emitSteps(): void {
    if (stepsSent) return
    stepsSent = true
    // Labels are resolved renderer-side from `progress.phaseLabel.<phase>`;
    // we still send the i18n labelKey as a fallback label so ambient
    // surfaces never show a raw slug.
    sendProgress('steps', {
      steps: phases.map((p) => ({ phase: p.phase, label: p.labelKey })),
    })
  }

  /** Advance to `idx` (if it's ahead of the current phase) and emit entry. */
  function enterPhase(idx: number): void {
    if (idx <= activeIdx) return
    activeIdx = idx
    const def = phases[idx]!
    sendProgress(def.phase, {
      status: entryStatus(def),
      percent: entryPercent(def),
    })
  }

  /** Percent to report on phase entry, before any in-phase detail arrives:
   *   - streaming phases → -1 (indeterminate; the bar rides the slide)
   *   - countable customNodes → 0 (we'll fill as nodes import)
   *   - other determinate phases → 100 (fast; no finer signal) */
  function entryPercent(def: LaunchPhaseDef): number {
    if (def.streaming) return -1
    if (def.phase === 'customNodes' && nodeCount > 0) return 0
    return 100
  }

  /**
   * Sub-status for a phase on ENTRY (before any in-phase log detail). Returns
   * a literal for the countable node phase, the VRAM literal for gpu, else an
   * empty string so the step shows just its caption until real activity lands.
   * The renderer resolves `launch.activity.*` keys but passes literals through.
   */
  function entryStatus(def: LaunchPhaseDef): string {
    if (def.phase === 'gpu' && vramGb !== null) return `${vramGb} GB VRAM`
    if (def.phase === 'customNodes' && nodeCount > 0) return nodeCountLabel()
    return ''
  }

  function nodeCountLabel(): string {
    return `${Math.min(nodesSeen, nodeCount)} / ${nodeCount}`
  }

  function handleLine(rawLine: string): void {
    const line = rawLine.trimEnd()
    if (line.trim().length === 0) return

    // Steps + the synthetic first phase are emitted up front by `start()`;
    // a late call here is a safety net if `start()` was never invoked.
    emitSteps()

    // Skip-advance through any phase whose entry matcher hits on this line,
    // scanning from the furthest unmatched phase backward so a late milestone
    // (e.g. "Starting server") jumps straight there.
    for (let i = phases.length - 1; i > activeIdx; i--) {
      const def = phases[i]!
      const m = line.match(def.match)
      if (!m) continue
      if (def.phase === 'gpu' && m[1]) {
        const mb = Number(m[1])
        if (Number.isFinite(mb) && mb > 0) vramGb = Math.round(mb / 1024)
      }
      enterPhase(i)
      break
    }

    if (activeIdx < 0) return
    const def = phases[activeIdx]!

    // Level-2 live detail: countable node imports take priority (already a
    // human "N / M" + node name), otherwise translate a recognized log signal
    // into a human message. Raw log lines are NEVER surfaced.
    if (def.phase === 'customNodes' && nodeCount > 0) {
      const nodeMatch = line.match(NODE_IMPORT_LINE)
      if (nodeMatch) {
        nodesSeen++
        const pct = Math.min(100, Math.round((nodesSeen / nodeCount) * 100))
        const name = nodeMatch[1]?.replace(/\.py$/, '') ?? ''
        sendProgress(def.phase, {
          status: name ? `${nodeCountLabel()} · ${name}` : nodeCountLabel(),
          percent: pct,
        })
        return
      }
    }

    if (def.streaming) {
      const key = activityKeyFor(line)
      if (key) sendProgress(def.phase, { status: key, percent: -1 })
    }
  }

  let pending = ''
  return {
    start(): void {
      emitSteps()
      // Enter the synthetic first phase so `activePhase` is never null — the
      // stepper has a forward anchor from frame zero and never falls back to
      // the last step. Only when phase 0 is the never-matching `launchStart`.
      if (activeIdx < 0 && phases.length > 0) enterPhase(0)
    },
    ingest(chunk: string): void {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    },
  }
}
