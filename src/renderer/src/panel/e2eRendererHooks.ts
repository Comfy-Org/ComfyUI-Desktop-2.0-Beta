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
import type { ShowProgressOpts } from '../types/ipc'

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

interface PanelBindings {
  showProgress: (opts: ShowProgressOpts) => Promise<void> | void
}

let bindings: PanelBindings | null = null

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
  }
  ;(globalThis as unknown as { __e2eRenderer: E2ERendererHelpers }).__e2eRenderer = helpers
}
