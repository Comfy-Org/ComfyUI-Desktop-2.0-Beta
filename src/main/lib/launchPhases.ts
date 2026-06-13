/**
 * Launch progress phases — the single source of truth for the startup
 * progress bar's steps, ordered and weighted by the REAL boot timeline
 * (verified against `~/Library/Logs/ComfyUI/*.log`).
 *
 * Each phase declares:
 *   - `phase`   stable id, the IPC phase key and the i18n suffix the renderer
 *               resolves the label from (`progress.phaseLabel.<phase>`)
 *   - `match`   regex whose FIRST match in stdout marks ENTRY into this phase
 *   - `weight`  share of the 0→100 bar this phase owns (all weights sum to 1);
 *               sent inline on the IPC steps payload so the renderer paces the
 *               bar straight from here — this module is the single source
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
    match: NEVER,
    weight: 0.05,
    streaming: true,
  },
  {
    phase: 'securityScan',
    match: /Adding extra search path|ComfyUI startup time/i,
    weight: 0.05,
    streaming: false,
  },
  {
    phase: 'mountLibraries',
    match: /\[DONE\] Security scan/i,
    weight: 0.05,
    streaming: true,
  },
  {
    // Entry captures VRAM (group 1). The long torch/mps init lives inside
    // this phase, so it owns the largest slot and streams live activity.
    phase: 'gpu',
    match: /Total VRAM\s+(\d+)\s*MB/i,
    weight: 0.50,
    streaming: true,
  },
  {
    phase: 'customNodes',
    match: /ComfyUI version:|Import times for custom nodes:/i,
    weight: 0.15,
    streaming: false,
  },
  {
    // The tail. Indeterminate + streaming so the bar shows live log lines
    // (not a frozen 99%) until the existing transition into ComfyUI fires.
    phase: 'startingServer',
    match: /Starting server|To see the GUI go to:|Uvicorn running on/i,
    weight: 0.20,
    streaming: true,
  },
]

/**
 * Synthetic pre-launch steps, injected ahead of the normal phases when a repair
 * ran during launch prep (see `handleLaunch`). Each uses a `NEVER` matcher and
 * is entered programmatically like `launchStart`, completed once the first real
 * boot milestone fires. Weights add on top of the base 1.0; the renderer
 * normalizes, so injection just shrinks every slot proportionally.
 *
 *   - `repair`      interrupted-op source rollback was performed
 *   - `torchRepair` GPU PyTorch was restored after the v1.13.0 `--upgrade` bug
 */
export type PreLaunchPhase = 'repair' | 'torchRepair'

const PRE_LAUNCH_PHASES: Record<PreLaunchPhase, LaunchPhaseDef> = {
  repair: { phase: 'repair', match: NEVER, weight: 0.1, streaming: true },
  torchRepair: { phase: 'torchRepair', match: NEVER, weight: 0.1, streaming: true },
}

/** Starter-template model download, shown as the LAST launch step. Synthetic +
 *  streaming: its bytes downloaded in the background since install-begin, and a
 *  500 ms reader in `handleLaunch` feeds the rich substatus from the shared
 *  download state.
 *
 *  Placed at the very end (after `startingServer`) on purpose: every other
 *  install+launch step finishes first, so a still-running download can't make
 *  the earlier steps' bar jump, and the "Skip model download" footer button —
 *  gated on `template-models` being the active row — only appears once nothing
 *  else is left. (The store's monotonic `activePhase` guard keeps the early
 *  reader ticks from pulling the active row here before its turn.)
 *
 *  Weight matches the other light launch phases so a STILL-RUNNING download
 *  fills its slot smoothly (the bar advances with the bytes). When the models
 *  were already fetched in the background by launch time (the common case), the
 *  reader in `handleLaunch` reports it INDETERMINATE so the slot isn't filled in
 *  one frame. */
const TEMPLATE_MODELS_PHASE: LaunchPhaseDef = {
  phase: 'template-models',
  match: NEVER,
  weight: 0.05,
  streaming: true,
}

export interface BuildLaunchPhasesOpts {
  /** Synthetic repair steps to prepend, in display order (e.g. a source
   *  rollback then a PyTorch restore). Omitted/empty for an unaffected launch. */
  preLaunchPhases?: PreLaunchPhase[]
  /** When true, append the `template-models` phase as the final launch step. */
  templateModels?: boolean
}

/**
 * Build the launch phase list for an installation. This is the single hook
 * where conditional steps get spliced in WITHOUT touching the tracker or the
 * renderer — exactly the arbitrary-step extensibility requested. The tracker
 * derives everything (steps payload, weights, matchers) from whatever array
 * this returns; the renderer paces from the inline weights, so an injected step
 * just renormalizes the bar.
 *
 * Adding a step is one entry in `PRE_LAUNCH_PHASES` + a push here. `inst` is
 * untyped so this module stays decoupled from the main/renderer record split.
 */
export function buildLaunchPhases(_inst: unknown, opts: BuildLaunchPhasesOpts = {}): LaunchPhaseDef[] {
  const pre = (opts.preLaunchPhases ?? []).map((id) => ({ ...PRE_LAUNCH_PHASES[id] }))
  const phases = [...pre, ...DEFAULT_LAUNCH_PHASES.map((p) => ({ ...p }))]
  if (opts.templateModels) {
    // Append as the final step so every other install+launch phase completes
    // before the (background) model download becomes the active row.
    phases.push({ ...TEMPLATE_MODELS_PHASE })
  }
  return phases
}
