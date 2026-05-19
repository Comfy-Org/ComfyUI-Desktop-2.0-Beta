import type { ProgressStep } from '../types/ipc'

/**
 * Per-op weight tables for the unified `globalProgress` bar.
 *
 * Each table maps `phase` → weight in `[0, 1]`; weights for one op sum to
 * 1.0. The active phase contributes `weight * (phasePercent / 100)`, every
 * phase strictly before it contributes its full weight. Phases that report
 * indeterminate (`percent === -1`) contribute 0 while active, and the
 * caller flags the bar as indeterminate so the slide animation rides on
 * top of the held fill — that's what prevents the bar from regressing
 * when an indeterminate phase starts.
 *
 * Tables are keyed by the **sorted phase-name fingerprint** of `op.steps`,
 * not by op title. Op titles vary by install name (`"Installing — My
 * Comfy"`); the phase set is the durable identity of the op shape.
 *
 * Calibration notes:
 *   - Numbers reflect "what dominates wall time in the median run."
 *     download is the biggest chunk on cold installs; setup (uv pip
 *     copying the template venv) is the second biggest on local SSDs.
 *   - Bad calibration → bar moves at the wrong speed in one section.
 *     It does NOT cause regressions; the monotonic clamp in
 *     `progressStore.globalProgressFor` handles that.
 *   - When a new op shape ships in main before the table is updated,
 *     `getPhaseWeights` falls back to equal weights across all phases.
 */
const TABLES: Record<string, Record<string, number>> = {
  // Standalone install — common case (no pending snapshot)
  'cleanup|download|extract|setup|update': {
    download: 0.40,
    extract: 0.20,
    setup: 0.30,
    cleanup: 0.05,
    update: 0.05,
  },
  // Standalone install + snapshot restore
  'cleanup|download|extract|restore-nodes|restore-pip|setup|update': {
    download: 0.30,
    extract: 0.15,
    setup: 0.20,
    cleanup: 0.05,
    update: 0.05,
    'restore-nodes': 0.15,
    'restore-pip': 0.10,
  },
  // Portable install (no Python env, no update probe)
  'download|extract': {
    download: 0.70,
    extract: 0.30,
  },
  // Legacy Desktop migrate
  migration: {
    migration: 1.0,
  },
  // Migrate + snapshot restore
  'migration|restore-nodes|restore-pip': {
    migration: 0.70,
    'restore-nodes': 0.18,
    'restore-pip': 0.12,
  },
}

export function fingerprintSteps(steps: readonly ProgressStep[]): string {
  return steps
    .map((s) => s.phase)
    .slice()
    .sort()
    .join('|')
}

/**
 * Returns the weight table for an op's phase set. Falls back to equal
 * weights if the fingerprint isn't in `TABLES` — keeps the bar
 * monotonic for future / experimental op shapes without requiring a
 * code change in lockstep with main.
 */
export function getPhaseWeights(
  steps: readonly ProgressStep[],
): Record<string, number> {
  const fp = fingerprintSteps(steps)
  const known = TABLES[fp]
  if (known) return known
  // Equal-weights fallback.
  const n = steps.length
  if (n === 0) return {}
  const w = 1 / n
  const out: Record<string, number> = {}
  for (const s of steps) out[s.phase] = w
  return out
}
