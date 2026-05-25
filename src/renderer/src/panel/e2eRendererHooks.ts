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
import type { ShowProgressOpts } from '../types/ipc'

export interface InjectProgressErrorOpts {
  installationId: string
  /** Title shown in the ProgressModal header. */
  title?: string
  /** Body of the error block (`currentOp.error`). Long strings exercise
   *  the overflow / clamp rules on `.brand-progress__error-message`. */
  errorMessage: string
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
 * previous reference.
 */
export function bindE2EPanelHooks(next: PanelBindings): void {
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
  }
  ;(globalThis as unknown as { __e2eRenderer: E2ERendererHelpers }).__e2eRenderer = helpers
}
