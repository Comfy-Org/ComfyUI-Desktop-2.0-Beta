import { defineStore } from 'pinia'
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from './sessionStore'
import { getPhaseWeights } from '../lib/progressWeights'
import type {
  ActionResult,
  ErrorDetailData,
  ProgressData,
  ProgressStep,
  ComfyOutputData,
  ShowProgressOpts,
  Unsubscribe,
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

  // Listen for async error detail updates (e.g. locking process names resolved after the initial error)
  window.api.onErrorDetail((data: ErrorDetailData) => {
    const op = operations.get(data.installationId)
    if (op?.error) {
      op.error = data.message
      const session = sessionStore.errorInstances.get(data.installationId)
      if (session) session.message = data.message
    }
  })

  function cleanupOperation(installationId: string): void {
    const op = operations.get(installationId)
    if (!op) return
    if (op.unsubProgress) op.unsubProgress()
    if (op.unsubOutput) op.unsubOutput()
    op.unsubProgress = null
    op.unsubOutput = null
  }

  function getProgressInfo(
    installationId: string
  ): { status: string; percent: number } | null {
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
  }): void {
    const { installationId, title, apiCall, returnTo, opKind, destroysInstance } = opts

    cleanupOperation(installationId)

    sessionStore.startSession(installationId)
    const sessionLabel = title.split(' — ')[0] || t('progress.working')
    sessionStore.setActiveSession(installationId, sessionLabel)

    const op: Operation = {
      title: title || t('progress.working'),
      returnTo,
      opKind: opKind ?? 'generic',
      destroysInstance: !!destroysInstance,
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
      unsubProgress: null,
      unsubOutput: null,
      apiCall,
      _globalFloor: 0,
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
        message: rop.error,
      })
      return
    }

    p
      .then((result) => {
        rop.finished = true
        if (result.ok || result.cancelled || result.portConflict) rop.result = result
        cleanupRop()

        sessionStore.clearActiveSession(installationId)

        if (result.ok) {
          if (rop.steps) rop.done = true
        } else if (!result.cancelled && !result.portConflict) {
          rop.error = result.message || t('progress.unknownError')
          sessionStore.errorInstances.set(installationId, {
            installationName: rop.title,
            message: rop.error,
          })
        }
      })
      .catch((err: Error) => {
        rop.error = err.message
        rop.finished = true
        cleanupRop()
        sessionStore.clearActiveSession(installationId)
        sessionStore.errorInstances.set(installationId, {
          installationName: rop.title,
          message: rop.error,
        })
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
    const activeIdx = op.activePhase
      ? op.steps.findIndex((s) => s.phase === op.activePhase)
      : -1

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
    const total = op.activePercent < 0
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
    cancelOperation,
  }
})
