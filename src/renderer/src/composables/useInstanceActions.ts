import type { NavDecision } from '../../../shared/navigation/navDecision'
import type { Installation } from '../types/ipc'

/**
 * Single funnel for executing a navigation `NavDecision` against the host
 * bridge. The decision (what to do) is computed by `decideNavigation`; this
 * routes the chosen verb onto the existing preload bridge primitives, applying
 * the renderer-side gates (cloud capacity, local kill-confirm) that main would
 * otherwise re-prompt for.
 *
 * Keeping verb→bridge routing here means the picker view no longer hand-codes
 * `pickInstall` vs `restartInstall` vs `openInstallNewWindow` — it asks for a
 * decision and dispatches it.
 */
export interface InstanceActionsBridge {
  /** Swap the install into the current window (detach + re-attach in place). */
  pickInstall: (installationId: string) => void
  /** Restart the install running in the current window. `confirmed` tells main
   *  the renderer already prompted, so it skips its own system-modal. */
  restartInstall: (installationId: string, opts?: { confirmed?: boolean }) => void
  /** Land the install in its own window, leaving the current one untouched.
   *  `allowDuplicate` opens a second window for an install that already owns
   *  one (cloud-self only). */
  openInstallNewWindow?: (installationId: string, opts?: { allowDuplicate?: boolean }) => void
  /** Open the new-install wizard. */
  openNewInstall?: () => void
}

export interface InstanceActionsDeps {
  bridge: InstanceActionsBridge | undefined
  /** Confirm a local process kill (restart/switch). Returns true to proceed;
   *  non-local installs have no process to kill and should resolve true. */
  confirmLocalKill: (inst: Installation) => Promise<boolean>
  /** Cloud capacity gate; returns false to abort a cloud action. */
  confirmCloudCapacity: (inst: Installation) => Promise<boolean>
}

export interface InstanceActions {
  /** Execute a navigation decision against the target install. */
  dispatch: (decision: NavDecision, target: Installation) => Promise<void>
}

export function useInstanceActions(deps: InstanceActionsDeps): InstanceActions {
  /**
   * Route a decision's verb onto the bridge. A rejected confirm dialog (e.g. the
   * host tears down mid-prompt) is treated as "not confirmed" — the action
   * aborts instead of surfacing an unhandled rejection to the caller.
   */
  async function dispatch(decision: NavDecision, target: Installation): Promise<void> {
    const { bridge } = deps
    if (!bridge) return

    try {
      // Cloud capacity gate first — applies to any cloud action that lands a
      // session (matches the ChooserView path so the two can't diverge).
      if (target.sourceCategory === 'cloud' && !(await deps.confirmCloudCapacity(target))) return

      switch (decision.verb) {
        case 'restart': {
          // Local restarts confirm in-drawer; `confirmed: true` tells main to
          // skip its own modal. Non-local installs resolve true (no process).
          if (!(await deps.confirmLocalKill(target))) return
          bridge.restartInstall(target.id, { confirmed: true })
          return
        }
        case 'switch': {
          // An in-place switch over a local current host carries `kill-local`;
          // confirm before detaching.
          if (decision.confirm === 'kill-local' && !(await deps.confirmLocalKill(target))) return
          bridge.pickInstall(target.id)
          return
        }
        case 'open-new': {
          bridge.openInstallNewWindow?.(target.id, { allowDuplicate: decision.allowDuplicate })
          return
        }
        case 'focus': {
          // Same bridge call as a pick — main short-circuits to `window.focus()`
          // when the install is already up. No confirm: nothing is killed.
          bridge.pickInstall(target.id)
          return
        }
        case 'install-wizard': {
          bridge.openNewInstall?.()
          return
        }
        case 'no-op':
          return
      }
    } catch (err) {
      console.error('useInstanceActions.dispatch failed:', err)
    }
  }

  return { dispatch }
}
