/**
 * Renderer-side test-only helpers exposed on `globalThis.__e2eRenderer`
 * so Playwright's `panel.evaluate(...)` bridge can drive UI state that
 * is normally produced by long-running production code paths (action
 * runs, IPC settlement, error injection).
 *
 * `PanelApp` registers the binding callbacks during setup once it has
 * its overlay + progress wires available. Test code calls the helpers
 * via `panel.evaluate('window.__e2eRenderer.foo(...)')`.
 *
 * Production code never references `__e2eRenderer`, so the global is a
 * no-op outside the test runner.
 */
import { useSessionStore } from '../stores/sessionStore'
import type { ActionResult, ShowProgressOpts } from '../types/ipc'

export interface InjectProgressErrorOpts {
  installationId: string
  /** Title shown in the ProgressModal header. */
  title?: string
  /** Body of the error block (`currentOp.error`). Long strings exercise
   *  the overflow / clamp rules on `.brand-progress__error-message`. */
  errorMessage: string
}

export interface InjectProgressSuccessOpts {
  /** Install id the operation runs against (the source of a copy /
   *  copy-update / release-update). */
  installationId: string
  title?: string
  /** Drives ProgressModal's handleDone — when set, the modal calls
   *  `window.api.openInstallWindow(newInstallationId)` after the op
   *  finishes. Used by the FLOW 2 e2e to exercise the destination-open
   *  path without running a real copy. */
  newInstallationId?: string
}

export interface InjectRetryableProgressErrorOpts {
  installationId: string
  title?: string
  errorMessage: string
  /** Number of consecutive failures before the apiCall flips to
   *  resolving with `{ ok: true }`. Defaults to 1 — i.e. fail once,
   *  succeed on the first Reboot. */
  failuresBeforeSuccess?: number
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
  /** Marks the op as non-destroying (default) so ProgressModal renders
   *  the Return-to-Dashboard footer button rather than Cancel. */
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

/** Per-installation invocation counter for the apiCall seeded by
 *  `injectRetryableProgressError`. Module-scoped so the closure that
 *  the progressStore captures and the test-side
 *  `getInjectedApiCallCount` reader observe the same Map. */
const injectedApiCallCounts = new Map<string, number>()

/** Deferred apiCall promises for ops seeded via `startInFlightOp`,
 *  keyed by installationId so `settleInFlightOp` can resolve the right
 *  one. Module-level so the renderer's progressStore captures the same
 *  promise reference its `then` chain awaits. */
const inFlightSettlers = new Map<string, (result: ActionResult) => void>()

export interface E2ERendererHelpers {
  /** Drive the PanelApp's normal show-progress chain with an `apiCall`
   *  that resolves to `{ ok: false, message }` so `ProgressModal`
   *  mounts and paints its post-failure state with the supplied error.
   *  Used by the progress-error-overflow e2e to guarantee a long error
   *  reliably reaches the DOM without provoking a real failing
   *  install. */
  injectProgressError(opts: InjectProgressErrorOpts): Promise<void>
  /** Drive the PanelApp's show-progress chain with a synthetic
   *  successful copy-style result. Used by the FLOW 2 e2e to verify
   *  `ProgressModal.handleDone` calls `openInstallWindow` with
   *  `newInstallationId` without running an actual copy. */
  injectProgressSuccess(opts: InjectProgressSuccessOpts): Promise<void>
  /** Read the renderer-side `sessionStore.isRunning(id)` so tests can
   *  poll on the broadcast having actually propagated into the panel's
   *  Pinia store (main's `_test_clearRunningSessions` fires the IPC but
   *  resolves before the renderer applies the resulting
   *  `instance-stopped` message — without this poll the apiCall-time
   *  `wasRunning` capture races the broadcast). */
  isRunning(installationId: string): boolean
  /** Drive the show-progress chain with an apiCall that fails the
   *  first `failuresBeforeSuccess` times and then resolves with
   *  `{ ok: true }`. Used by the ProgressModal Reboot cluster to
   *  prove `handleReboot` re-runs the same `op.apiCall` (instead of
   *  the legacy fresh-launch fallback) and that recovery clears the
   *  error UI in place. */
  injectRetryableProgressError(opts: InjectRetryableProgressErrorOpts): Promise<void>
  /** Seed `sessionStore.errorInstances` directly so the renderer
   *  treats an install as pre-existing errored without having to fail
   *  a real op first. Mirrors the broadcast path the launcher uses
   *  when a crash arrives before any UI took an action on the
   *  install. */
  seedErrorInstance(opts: SeedErrorInstanceOpts): void
  /** True iff `sessionStore.errorInstances` has an entry for the id. */
  hasErrorInstance(installationId: string): boolean
  /** Read the recorded invocation count for the apiCall most recently
   *  seeded via `injectRetryableProgressError`. Lets the test prove
   *  `handleReboot` re-invoked the same closure (count went from 1 → 2)
   *  rather than the fresh-launch fallback. */
  getInjectedApiCallCount(installationId: string): number
  /** Seed an in-flight op whose `apiCall` is a controllable Promise so
   *  the op stays pending until `settleInFlightOp` resolves it. Lets
   *  tests exercise the busy-guard / Return-to-Dashboard / cancel-flow
   *  branches without driving a real long-running action. */
  startInFlightOp(opts: StartInFlightOpOpts): Promise<void>
  /** Resolve the deferred `apiCall` for a pending in-flight op. Returns
   *  `false` if no settler exists (op was never seeded, or already
   *  resolved). */
  settleInFlightOp(opts: SettleInFlightOpOpts): boolean
  /** Run `useActionGuard.checkBeforeAction(installationId, label)`
   *  directly so the test can drive the busy-guard surface without
   *  going through a real action runner. Returns the guard's verdict
   *  (true = proceed, false = user cancelled the confirm). */
  runActionGuard(opts: { installationId: string; actionLabel: string }): Promise<boolean>
}

function ensureBound(): PanelBindings {
  if (!bindings) {
    throw new Error('__e2eRenderer not bound yet — PanelApp has not mounted')
  }
  return bindings
}

/**
 * Called from `PanelApp.vue` once `handleShowProgress` is in scope.
 * Re-binding (e.g. PanelApp re-mount after panel switch) replaces the
 * previous reference; passing `null` clears it so a stale closure
 * captured by a detached component instance can't keep driving the
 * progress chain after unmount.
 */
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
        // Resolves immediately with `{ ok: false }` carrying the long
        // error message. The store routes that through the same code
        // path a real action failure takes.
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
      // Reset any prior counter for the same id so a leaked op from a
      // previous test can't intercept this one's call-count assertions.
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
      // Replace any prior settler for the same id so a leaked op from a
      // previous test can't intercept this one's resolve.
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
