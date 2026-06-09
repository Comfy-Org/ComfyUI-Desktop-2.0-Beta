/**
 * Launch progress phases — the single source of truth for the startup
 * progress bar's steps, ordered and weighted by the REAL boot timeline
 * (verified against `~/Library/Logs/ComfyUI/*.log`).
 *
 * Each phase declares:
 *   - `phase`   stable id, also the IPC phase key and i18n suffix
 *   - `labelKey` i18n key for the step label shown in the progress UI
 *   - `match`   regex whose FIRST match in stdout marks ENTRY into this phase
 *   - `weight`  share of the 0→100 bar this phase owns (all weights sum to 1)
 *   - `streaming` true ⇒ the phase is unbounded; its sub-activity row shows a
 *                 spinner + live log line rather than a determinate percent
 *
 * Weights are deliberately `gpu`-heavy: the ~40s torch/mps init between
 * "Total VRAM" and "ComfyUI version" is the real time sink, not custom-node
 * import (which batch-prints in a few seconds). Mis-calibration only mis-paces
 * a section — the renderer's monotonic clamp prevents the bar regressing.
 *
 * Phases are a plain array so a caller can inject a step conditionally
 * (e.g. a "Repairing installation" step) before handing them to the tracker —
 * see `buildLaunchPhases`.
 */
export interface LaunchPhaseDef {
  phase: string
  labelKey: string
  match: RegExp
  weight: number
  streaming: boolean
}

/** A regex that never matches — for synthetic phases (like `launchStart`)
 *  that are entered programmatically, not by a log line. */
const NEVER = /$^/

/** Ordered default launch phases. Entry matchers are anchored to stable
 *  ComfyUI startup lines; see the verified timeline in the module header. */
export const DEFAULT_LAUNCH_PHASES: readonly LaunchPhaseDef[] = [
  {
    // Synthetic first step, active from frame zero (before any stdout) so the
    // launch op is stepped immediately — no separate flat "Starting ComfyUI"
    // bar, one continuous stepper. Auto-completes when `securityScan` (the
    // first real milestone) fires via skip-advance.
    phase: 'launchStart',
    labelKey: 'launch.steps.launchStart',
    match: NEVER,
    weight: 0.05,
    streaming: true,
  },
  {
    phase: 'securityScan',
    labelKey: 'launch.steps.securityScan',
    match: /Adding extra search path|ComfyUI startup time/i,
    weight: 0.05,
    streaming: false,
  },
  {
    phase: 'mountLibraries',
    labelKey: 'launch.steps.mountLibraries',
    match: /\[DONE\] Security scan/i,
    weight: 0.05,
    streaming: true,
  },
  {
    // Entry captures VRAM (group 1). The long torch/mps init lives inside
    // this phase, so it owns the largest slot and streams live activity.
    phase: 'gpu',
    labelKey: 'launch.steps.gpu',
    match: /Total VRAM\s+(\d+)\s*MB/i,
    weight: 0.50,
    streaming: true,
  },
  {
    phase: 'customNodes',
    labelKey: 'launch.steps.customNodes',
    match: /ComfyUI version:|Import times for custom nodes:/i,
    weight: 0.15,
    streaming: false,
  },
  {
    // The tail. Indeterminate + streaming so the bar shows live log lines
    // (not a frozen 99%) until the existing transition into ComfyUI fires.
    phase: 'startingServer',
    labelKey: 'launch.steps.startingServer',
    match: /Starting server|To see the GUI go to:|Uvicorn running on/i,
    weight: 0.20,
    streaming: true,
  },
]

/**
 * The repair phase shown while we fix installs broken by the v1.13.0 bug
 * (Jędrzej's ask). It runs first — before security scan — because the repair
 * happens during early boot. Injected only when `opts.needsRepair` is set, so
 * unaffected users never see it.
 */
const REPAIR_PHASE: LaunchPhaseDef = {
  phase: 'repair',
  labelKey: 'launch.steps.repair',
  // Adjust to whatever marker the repair flow prints once it lands.
  match: /Repairing|\[repair\]|fixing install/i,
  weight: 0.15,
  streaming: true,
}

export interface BuildLaunchPhasesOpts {
  /** Inject the v1.13.0 "Repairing installation…" phase. */
  needsRepair?: boolean
}

/**
 * Build the launch phase list for an installation. This is the single hook
 * where a conditional step gets spliced in WITHOUT touching the tracker or
 * the renderer — exactly the arbitrary-step extensibility requested. The
 * tracker derives everything (steps payload, weights, matchers) from whatever
 * array this returns; the renderer keys its weight table off the sorted phase
 * fingerprint, so a new fingerprint just falls back to equal weighting safely.
 *
 * Adding a step is one conditional `unshift`/`splice` here. `inst` is untyped
 * so this module stays decoupled from the main/renderer record split.
 */
export function buildLaunchPhases(_inst: unknown, opts: BuildLaunchPhasesOpts = {}): LaunchPhaseDef[] {
  const phases = DEFAULT_LAUNCH_PHASES.map((p) => ({ ...p }))
  if (opts.needsRepair) {
    phases.unshift({ ...REPAIR_PHASE })
  }
  return phases
}
