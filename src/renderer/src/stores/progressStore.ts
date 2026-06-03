import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from './sessionStore'
import { getPhaseWeights } from '../lib/progressWeights'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import type {
  ActionResult,
  ErrorDetailData,
  ProgressData,
  ProgressStep,
  ComfyOutputData,
  ShowProgressOpts,
  Unsubscribe
} from '../types/ipc'

export interface Operation {
  title: string
  returnTo?: string
  /** Categorises this op for ProgressModal so the brand branch can
   *  pick the right caption set + finished-state copy. Defaults to
   *  `'generic'` when the host doesn't tag the op; only launch ops
   *  drive the rolling 5-step launchCaption pipeline. */
  opKind: NonNullable<ShowProgressOpts['opKind']>
  /** Mirrors `ShowProgressOpts.destroysInstance`. Carried on the op so
   *  ProgressModal's footer can swap Reboot for a no-Reboot finished
   *  state and the success path can auto-detach the host. */
  destroysInstance: boolean
  /** Mirrors `ShowProgressOpts.chainSpan`. When set, ProgressModal's
   *  unified bar maps the install leg to 0–70% and the launch leg to
   *  70–100% so the user sees one continuous 0→100% journey instead of
   *  the bar hitting 100 mid-install and stalling through the launch
   *  tail. Standalone ops leave this unset. */
  chainSpan: 'install' | 'launch' | null
  /** Optional success-terminal screen rendered by ProgressModal in
   *  place of the auto-close. Picker-driven mutating-non-launch ops opt
   *  in to surface a follow-up choice (e.g. `[Go to Dashboard | Open
   *  Instance]`) so the user can decide whether to enter the app after
   *  the op completes. */
  successTerminal: NonNullable<ShowProgressOpts['successTerminal']> | null
  steps: ProgressStep[] | null
  activePhase: string | null
  activePercent: number
  lastStatus: Record<string, string>
  flatStatus: string
  flatPercent: number
  terminalOutput: string
  done: boolean
  error: string | null
  finished: boolean
  cancelRequested: boolean
  result: ActionResult | null
  /** Action id that kicked off this op (`copy-install`, `copy-update`,
   *  `update`, `restore-snapshot`, …). Carried so the op-outcome event
   *  can split the funnel by the exact path the user took — opKind
   *  alone collapses copy-update / release-update / update into
   *  `'update'` and copy-install into `'generic'`. */
  actionId?: string
  /** Wall-clock start, for the op-outcome event's duration_ms. */
  _startedAtMs: number
  /** One-shot guard so `comfy.desktop.op.result` fires exactly once per op
   *  (a terminal transition AND a later cleanup must not double-count). */
  _resultEmitted: boolean
  unsubProgress: Unsubscribe | null
  unsubOutput: Unsubscribe | null
  apiCall: (() => Promise<ActionResult>) | null
  /** Monotonic floor for the unified `globalProgressFor` bar. Lazily
   *  raised; never decremented. See `globalProgressFor` for the full
   *  contract. Underscored because it's internal to the store — UI code
   *  should read through `globalProgressFor`, not this field. */
  _globalFloor: number
}

export const useProgressStore = defineStore('progress', () => {
  const { t } = useI18n()
  const sessionStore = useSessionStore()

  const operations = reactive(new Map<string, Operation>())

  // Listen for async error detail updates (e.g. locking process names resolved after the initial error).
  // Guarded — the picker popup's `window.api` shim does not forward
  // `onErrorDetail`, and a hard call would throw at store construction
  // and silently blank the entire ComfyUISettingsContent right pane.
  window.api.onErrorDetail?.((data: ErrorDetailData) => {
    const op = operations.get(data.installationId)
    if (op?.error) {
      op.error = data.message
      const session = sessionStore.errorInstances.get(data.installationId)
      if (session) session.message = data.message
    }
  })

  /**
   * Fire `comfy.desktop.op.result` exactly once per operation. This is the
   * outcome half of the multi-instance funnel: `comfy.desktop.action.invoked`
   * (with `action_id`) marks the click; this marks how it ended.
   *
   * `result`:
   *   - `success`          — apiCall resolved ok
   *   - `failed`           — sync throw, rejected promise, or ok:false
   *                          (carries `error_bucket`)
   *   - `cancelled_user`   — user clicked Cancel (apiCall resolved
   *                          `cancelled` after `cancelOperation`)
   *   - `cancelled_abrupt` — op torn down before any terminal state
   *                          (window closed / replaced mid-flight)
   *
   * `portConflict` is deliberately NOT terminal — the op stays alive
   * pending resolution, so we don't emit for it.
   */
  function emitOpResult(
    op: Operation,
    installationId: string,
    result: 'success' | 'failed' | 'cancelled_user' | 'cancelled_abrupt'
  ): void {
    if (op._resultEmitted) return
    op._resultEmitted = true
    emitTelemetryAction('comfy.desktop.op.result', {
      installation_id: installationId,
      action_id: op.actionId ?? null,
      op_kind: op.opKind,
      // Panel/drawer/dashboard ops route through this store; picker-
      // initiated ops emit their own op.result main-side tagged
      // `source: 'picker'`. Lets the dashboard split the two surfaces.
      source: 'panel',
      result,
      duration_ms: Date.now() - op._startedAtMs,
      ...(result === 'failed' && op.error ? { error_bucket: toErrorBucket(op.error) } : {})
    })
  }

  function cleanupOperation(installationId: string): void {
    const op = operations.get(installationId)
    if (!op) return
    // An op torn down before reaching a terminal state = the user left
    // mid-way (window closed, or a new op replaced this one). Distinct
    // from a deliberate Cancel click, which resolves `cancelled` below.
    if (!op.finished && !op._resultEmitted) {
      emitOpResult(op, installationId, 'cancelled_abrupt')
    }
    if (op.unsubProgress) op.unsubProgress()
    if (op.unsubOutput) op.unsubOutput()
    op.unsubProgress = null
    op.unsubOutput = null
  }

  function getProgressInfo(installationId: string): { status: string; percent: number } | null {
    const op = operations.get(installationId)
    if (!op || op.finished) return null
    if (op.steps && op.activePhase) {
      const status = op.lastStatus[op.activePhase] || op.activePhase
      return { status, percent: op.activePercent }
    }
    return { status: op.flatStatus || op.title, percent: op.flatPercent }
  }

  function startOperation(opts: {
    installationId: string
    title: string
    apiCall: () => Promise<ActionResult>
    cancellable?: boolean
    returnTo?: string
    opKind?: ShowProgressOpts['opKind']
    destroysInstance?: boolean
    chainSpan?: ShowProgressOpts['chainSpan']
    successTerminal?: ShowProgressOpts['successTerminal']
    actionId?: string
  }): void {
    const {
      installationId,
      title,
      apiCall,
      returnTo,
      opKind,
      destroysInstance,
      chainSpan,
      successTerminal,
      actionId
    } = opts

    cleanupOperation(installationId)

    sessionStore.startSession(installationId)
    const sessionLabel = title.split(' — ')[0] || t('progress.working')
    sessionStore.setActiveSession(installationId, sessionLabel)

    const op: Operation = {
      title: title || t('progress.working'),
      returnTo,
      opKind: opKind ?? 'generic',
      destroysInstance: !!destroysInstance,
      chainSpan: chainSpan ?? null,
      successTerminal: successTerminal ?? null,
      steps: null,
      activePhase: null,
      activePercent: -1,
      lastStatus: {},
      flatStatus: t('progress.starting'),
      flatPercent: -1,
      terminalOutput: '',
      done: false,
      error: null,
      finished: false,
      cancelRequested: false,
      result: null,
      actionId,
      _startedAtMs: Date.now(),
      _resultEmitted: false,
      unsubProgress: null,
      unsubOutput: null,
      apiCall,
      _globalFloor: 0
    }
    operations.set(installationId, op)
    const rop = operations.get(installationId)!

    rop.unsubProgress = window.api.onInstallProgress((data: ProgressData) => {
      if (data.installationId !== installationId) return

      if (data.phase === 'steps' && data.steps) {
        rop.steps = data.steps
        rop.activePhase = null
        rop.activePercent = -1
        return
      }

      if (data.phase === 'done' && rop.steps) {
        rop.done = true
        return
      }

      if (rop.steps) {
        const stepIndex = rop.steps.findIndex((s) => s.phase === data.phase)
        if (stepIndex === -1) return
        rop.activePhase = data.phase
        rop.lastStatus[data.phase] = data.status || data.phase
        rop.activePercent = data.percent ?? -1
        return
      }

      if (!rop.cancelRequested) {
        rop.flatStatus = data.status || data.phase
      }
      if (data.percent !== undefined) {
        rop.flatPercent = data.percent
      }
    })

    rop.unsubOutput = window.api.onComfyOutput((data: ComfyOutputData) => {
      if (data.installationId !== installationId) return
      rop.terminalOutput += data.text
    })

    const cleanupRop = (): void => {
      if (rop.unsubProgress) rop.unsubProgress()
      if (rop.unsubOutput) rop.unsubOutput()
      rop.unsubProgress = null
      rop.unsubOutput = null
    }

    let p: Promise<ActionResult>
    try {
      p = apiCall()
    } catch (err) {
      rop.error = (err as Error).message || t('progress.unknownError')
      rop.finished = true
      cleanupRop()
      sessionStore.clearActiveSession(installationId)
      sessionStore.errorInstances.set(installationId, {
        installationName: rop.title,
        message: rop.error
      })
      emitOpResult(rop, installationId, 'failed')
      return
    }

    p.then((result) => {
      rop.finished = true
      if (result.ok || result.cancelled || result.portConflict) rop.result = result
      cleanupRop()

      sessionStore.clearActiveSession(installationId)

      if (result.ok) {
        if (rop.steps) rop.done = true
        emitOpResult(rop, installationId, 'success')
      } else if (result.cancelled) {
        emitOpResult(rop, installationId, 'cancelled_user')
      } else if (result.portConflict) {
        // Not terminal — the user resolves the conflict and a fresh op
        // (with its own outcome) supersedes this one. No op.result here.
      } else {
        rop.error = result.message || t('progress.unknownError')
        sessionStore.errorInstances.set(installationId, {
          installationName: rop.title,
          message: rop.error
        })
        emitOpResult(rop, installationId, 'failed')
      }
    }).catch((err: Error) => {
      rop.error = err.message
      rop.finished = true
      cleanupRop()
      sessionStore.clearActiveSession(installationId)
      sessionStore.errorInstances.set(installationId, {
        installationName: rop.title,
        message: rop.error
      })
      emitOpResult(rop, installationId, 'failed')
    })
  }

  function cancelOperation(installationId: string): void {
    const op = operations.get(installationId)
    if (!op) return
    // A finished op has nothing to cancel: the silent takeover→takeover
    // overlay swap fires `onCancel` indiscriminately, but stopping
    // ComfyUI here would punish the next op (or a relaunched session)
    // for the previous one having completed.
    if (op.finished) return
    op.cancelRequested = true
    op.flatStatus = t('progress.cancelling')
    window.api.cancelOperation(installationId)
    window.api.stopComfyUI(installationId)
  }

  /**
   * Unified 0→100 progress across an op's phases.
   *
   * Flat op (`steps === null`): passes through `flatPercent` — zero
   * behavioral change for chooser-launch / port-conflict / single-phase
   * ops.
   *
   * Stepped op:
   *   - Each phase has a weight from `getPhaseWeights`, summing to 1.0.
   *   - Phases strictly before the active phase contribute their full
   *     weight. The active phase contributes `weight * (percent/100)`
   *     when determinate; 0 when indeterminate (`-1`).
   *   - When the active phase is indeterminate, the bar fill HOLDS at
   *     the previous floor; the caller renders the slide animation on
   *     top via `indeterminate: true`. That's what stops the bar from
   *     regressing every time a `cleanup` / `update` phase starts.
   *
   * Monotonic clamp via `_globalFloor` on the op: a late-arriving smaller
   * value (retry, re-entering an earlier phase) can never walk the bar
   * backward.
   *
   * Finished ops snap to 100 on success; otherwise hold at the last
   * floor — the bar's "error" / "cancelled" visuals come from existing
   * `flatStatus` / `cancelRequested` paths, we just hand them a number
   * that doesn't reset.
   */
  function globalProgressFor(op: Operation): {
    percent: number
    indeterminate: boolean
  } {
    if (op.finished) {
      if (op.result?.ok) return { percent: 100, indeterminate: false }
      return { percent: op._globalFloor, indeterminate: false }
    }

    // Flat path — pass-through. Bar fills 0→flatPercent. The chooser-
    // launch path uses this (flat op, percent stays at -1 the whole time
    // → indeterminate slide animation flows left↔right, exactly what the
    // CTO described for the "starting server" stage).
    if (!op.steps) {
      const raw = op.flatPercent
      if (raw < 0) {
        return { percent: op._globalFloor, indeterminate: true }
      }
      const next = Math.max(op._globalFloor, raw)
      op._globalFloor = next
      return { percent: next, indeterminate: false }
    }

    // Stepped path.
    const weights = getPhaseWeights(op.steps)
    const activeIdx = op.activePhase ? op.steps.findIndex((s) => s.phase === op.activePhase) : -1

    if (activeIdx < 0 || !op.activePhase) {
      // Steps payload landed but no per-phase update yet. Hold the floor.
      return { percent: op._globalFloor, indeterminate: false }
    }

    // Sum the weight of every phase strictly before the active one.
    let baseline = 0
    for (let i = 0; i < activeIdx; i++) {
      const prev = op.steps[i]
      if (!prev) continue
      baseline += (weights[prev.phase] ?? 0) * 100
    }
    const activeWeight = (weights[op.activePhase] ?? 0) * 100

    // For an indeterminate active phase we have no granular percent to
    // report. Advance the bar smoothly to the END of this phase's slot
    // (`baseline + activeWeight`) so the user sees forward motion when
    // we transition from a determinate phase to an indeterminate one
    // (e.g. download → cleanup). Once the next phase starts, the
    // baseline absorbs that slot fully and the bar stays where it is.
    const total =
      op.activePercent < 0
        ? baseline + activeWeight
        : baseline + activeWeight * (op.activePercent / 100)

    const next = Math.max(op._globalFloor, total)
    op._globalFloor = next

    // No indeterminate flag for stepped ops — every phase shows a static
    // fill. The flat path is where the slide animation lives, which is
    // what the chooser-launch path uses for its "Starting server…"
    // final stage.
    return { percent: next, indeterminate: false }
  }

  return {
    operations,
    getProgressInfo,
    globalProgressFor,
    startOperation,
    cleanupOperation,
    cancelOperation
  }
})
