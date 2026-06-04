/** Test-only helpers on `globalThis.__e2eRenderer` so Playwright can drive
 *  UI state normally produced by long-running code paths. PanelApp binds
 *  the callbacks during setup; production never references the global. */
import { useSessionStore } from '../stores/sessionStore'
import type { ActionResult, ShowProgressOpts } from '../types/ipc'

export interface InjectProgressErrorOpts {
  installationId: string
  title?: string
  /** Body of the error block. Long strings exercise the overflow / clamp rules. */
  errorMessage: string
}

export interface InjectProgressSuccessOpts {
  installationId: string
  title?: string
  /** When set, ProgressModal's handleDone calls
   *  `window.api.openInstallWindow(newInstallationId)` after the op finishes. */
  newInstallationId?: string
}

export interface InjectRetryableProgressErrorOpts {
  installationId: string
  title?: string
  errorMessage: string
  /** Consecutive failures before the apiCall resolves `{ ok: true }`. Default 1. */
  failuresBeforeSuccess?: number
}

export interface InjectPortConflictResultOpts {
  installationId: string
  title?: string
  port: number
  /** When set, ProgressModal renders the "Use port N" CTA. */
  nextPort?: number
  /** Drives the visibility of the "Stop process and retry" CTA. */
  isComfy?: boolean
  pids?: number[]
}

export interface SeedErrorInstanceOpts {
  installationId: string
  installationName: string
  message?: string
}

export interface StartInFlightOpOpts {
  installationId: string
  title?: string
  opKind?: ShowProgressOpts['opKind']
  destroysInstance?: boolean
  triggersInstanceStart?: boolean
}

export interface SettleInFlightOpOpts {
  installationId: string
  result: ActionResult
}

interface PanelBindings {
  showProgress: (opts: ShowProgressOpts) => Promise<void> | void
  actionGuard: { checkBeforeAction: (id: string, label: string) => Promise<boolean> }
}

let bindings: PanelBindings | null = null

/** Per-installation invocation counter for the injected apiCall. */
const injectedApiCallCounts = new Map<string, number>()

/** Deferred apiCall resolvers for `startInFlightOp`, keyed by
 *  installationId so `settleInFlightOp` resolves the right one. */
const inFlightSettlers = new Map<string, (result: ActionResult) => void>()

export interface E2ERendererHelpers {
  /** Show-progress with an apiCall that resolves `{ ok: false, message }`
   *  so ProgressModal paints its post-failure state. */
  injectProgressError(opts: InjectProgressErrorOpts): Promise<void>
  /** Show-progress with a synthetic successful copy-style result. */
  injectProgressSuccess(opts: InjectProgressSuccessOpts): Promise<void>
  /** Read renderer-side `sessionStore.isRunning(id)` so tests can poll on
   *  the stop broadcast having propagated before asserting. */
  isRunning(installationId: string): boolean
  /** Show-progress with an apiCall that fails `failuresBeforeSuccess`
   *  times then resolves `{ ok: true }`, to test `handleReboot` re-runs
   *  the same `op.apiCall`. */
  injectRetryableProgressError(opts: InjectRetryableProgressErrorOpts): Promise<void>
  /** Show-progress with a port-conflict result. Increments
   *  `injectedApiCallCounts` so the "Kill Process" re-invocation is observable. */
  injectPortConflictResult(opts: InjectPortConflictResultOpts): Promise<void>
  /** Seed `sessionStore.errorInstances` directly without failing a real op. */
  seedErrorInstance(opts: SeedErrorInstanceOpts): void
  hasErrorInstance(installationId: string): boolean
  getInjectedApiCallCount(installationId: string): number
  /** Seed an in-flight op whose `apiCall` stays pending until `settleInFlightOp`. */
  startInFlightOp(opts: StartInFlightOpOpts): Promise<void>
  /** Resolve a pending in-flight op; `false` if no settler exists. */
  settleInFlightOp(opts: SettleInFlightOpOpts): boolean
  /** Run `useActionGuard.checkBeforeAction` directly. */
  runActionGuard(opts: { installationId: string; actionLabel: string }): Promise<boolean>
}

function ensureBound(): PanelBindings {
  if (!bindings) {
    throw new Error('__e2eRenderer not bound yet — PanelApp has not mounted')
  }
  return bindings
}

/** Called from `PanelApp.vue` once `handleShowProgress` is in scope.
 *  Pass `null` on unmount so a stale closure can't keep driving the chain. */
export function bindE2EPanelHooks(next: PanelBindings | null): void {
  bindings = next
}

export function registerE2ERendererHooks(): void {
  const helpers: E2ERendererHelpers = {
    async injectProgressError({ installationId, title, errorMessage }) {
      const b = ensureBound()
      await b.showProgress({
        installationId,
        title: title ?? `Failed op — ${installationId}`,
        opKind: 'generic',
        apiCall: () => Promise.resolve({ ok: false, message: errorMessage }),
      })
    },
    async injectProgressSuccess({ installationId, title, newInstallationId }) {
      const b = ensureBound()
      await b.showProgress({
        installationId,
        title: title ?? `Copy — ${installationId}`,
        opKind: 'generic',
        apiCall: () => Promise.resolve({
          ok: true,
          navigate: 'list',
          newInstallationId,
        }),
      })
    },
    isRunning(installationId) {
      return useSessionStore().isRunning(installationId)
    },
    async injectRetryableProgressError({ installationId, title, errorMessage, failuresBeforeSuccess }) {
      const b = ensureBound()
      const failsRequired = failuresBeforeSuccess ?? 1
      // Reset so a leaked op from a previous test can't skew the count.
      injectedApiCallCounts.set(installationId, 0)
      await b.showProgress({
        installationId,
        title: title ?? `Retryable failed op — ${installationId}`,
        opKind: 'generic',
        apiCall: () => {
          const next = (injectedApiCallCounts.get(installationId) ?? 0) + 1
          injectedApiCallCounts.set(installationId, next)
          return next <= failsRequired
            ? Promise.resolve({ ok: false, message: errorMessage })
            : Promise.resolve({ ok: true })
        },
      })
    },
    async injectPortConflictResult({ installationId, title, port, nextPort, isComfy, pids }) {
      const b = ensureBound()
      injectedApiCallCounts.set(installationId, 0)
      await b.showProgress({
        installationId,
        title: title ?? `Launching ComfyUI`,
        opKind: 'generic',
        triggersInstanceStart: true,
        apiCall: () => {
          const next = (injectedApiCallCounts.get(installationId) ?? 0) + 1
          injectedApiCallCounts.set(installationId, next)
          return Promise.resolve({
            ok: false,
            portConflict: {
              port,
              ...(pids !== undefined ? { pids } : {}),
              ...(nextPort !== undefined ? { nextPort } : {}),
              ...(isComfy !== undefined ? { isComfy } : {}),
            },
          })
        },
      })
    },
    seedErrorInstance({ installationId, installationName, message }) {
      useSessionStore().errorInstances.set(installationId, {
        installationName,
        message: message ?? `Seeded error for ${installationId}`,
      })
    },
    hasErrorInstance(installationId) {
      return useSessionStore().errorInstances.has(installationId)
    },
    getInjectedApiCallCount(installationId) {
      return injectedApiCallCounts.get(installationId) ?? 0
    },
    async startInFlightOp({ installationId, title, opKind, destroysInstance, triggersInstanceStart }) {
      const b = ensureBound()
      // Replace any prior settler so a leaked op can't intercept this resolve.
      inFlightSettlers.get(installationId)?.({ ok: false, cancelled: true })
      const pending = new Promise<ActionResult>((resolve) => {
        inFlightSettlers.set(installationId, resolve)
      })
      await b.showProgress({
        installationId,
        title: title ?? `In-flight — ${installationId}`,
        opKind: opKind ?? 'generic',
        destroysInstance: destroysInstance ?? false,
        triggersInstanceStart: triggersInstanceStart ?? false,
        apiCall: () => pending,
      })
    },
    settleInFlightOp({ installationId, result }) {
      const settle = inFlightSettlers.get(installationId)
      if (!settle) return false
      inFlightSettlers.delete(installationId)
      settle(result)
      return true
    },
    runActionGuard({ installationId, actionLabel }) {
      return ensureBound().actionGuard.checkBeforeAction(installationId, actionLabel)
    },
  }
  ;(globalThis as unknown as { __e2eRenderer: E2ERendererHelpers }).__e2eRenderer = helpers
}
