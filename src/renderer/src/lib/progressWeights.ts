import type { ProgressStep } from '../types/ipc'

/**
 * Per-op weight tables for the unified `globalProgress` bar. Each maps
 * `phase` → weight in `[0, 1]` summing to 1.0; weights reflect what
 * dominates wall time in the median run. Keyed by the sorted phase-name
 * fingerprint of `op.steps` (durable across install-name-varying titles).
 * Bad calibration only mis-paces a section — the monotonic clamp in
 * `progressStore.globalProgressFor` prevents regressions.
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
  // Legacy Desktop adoption (non-macOS — no `tcc` step). Source +
  // comfy-update + requirements dominate wall time; the rest are fast.
  'allocate|backup|comfy-update|register|requirements|settings|snapshot|source|venv': {
    backup: 0.05,
    venv: 0.03,
    snapshot: 0.05,
    allocate: 0.02,
    source: 0.30,
    'comfy-update': 0.15,
    requirements: 0.30,
    settings: 0.05,
    register: 0.05,
  },
  // Legacy Desktop adoption on macOS — same shape plus a `tcc` access
  // check step.
  'allocate|backup|comfy-update|register|requirements|settings|snapshot|source|tcc|venv': {
    backup: 0.05,
    tcc: 0.02,
    venv: 0.03,
    snapshot: 0.05,
    allocate: 0.02,
    source: 0.28,
    'comfy-update': 0.15,
    requirements: 0.30,
    settings: 0.05,
    register: 0.05,
  },
}

export function fingerprintSteps(steps: readonly ProgressStep[]): string {
  return steps
    .map((s) => s.phase)
    .slice()
    .sort()
    .join('|')
}

/** Returns the weight table for an op's phase set, falling back to equal
 *  weights when the fingerprint isn't in `TABLES`. */
export function getPhaseWeights(
  steps: readonly ProgressStep[],
): Record<string, number> {
  const fp = fingerprintSteps(steps)
  const known = TABLES[fp]
  if (known) return known
  const n = steps.length
  if (n === 0) return {}
  const w = 1 / n
  const out: Record<string, number> = {}
  for (const s of steps) out[s.phase] = w
  return out
}
