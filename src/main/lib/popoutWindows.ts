/**
 * Aggregate helpers over the terminal + logs pop-out windows so callers
 * (install detach, app quit, update/restore) close both surfaces with one
 * call instead of importing each module separately and risking one being
 * forgotten.
 */

import { disposeTerminal } from './terminal'
import { closeAllLogsPopouts, closeLogsPopout } from './logsPopoutWindow'
import { closeAllTerminalPopouts, closeTerminalPopout } from './terminalPopoutWindow'

/** Close both the terminal and logs pop-outs bound to a single install. */
export function closeInstallPopouts(installationId: string): void {
  closeTerminalPopout(installationId)
  closeLogsPopout(installationId)
}

/** Close every open pop-out window across all installs (e.g. on app quit). */
export function closeAllPopouts(): void {
  closeAllTerminalPopouts()
  closeAllLogsPopouts()
}

/**
 * Release everything bound to an install's shared shell before a destructive
 * filesystem operation (update / snapshot restore). On Windows a live shell
 * holds a handle on the install dir (its cwd) and any running `python` keeps
 * venv DLLs locked, so `uv pip` upgrades and `site-packages` removals fail
 * with EBUSY/EPERM. Closing the pop-outs and killing the shell drops those
 * locks; the next time a surface subscribes, the shell respawns lazily with
 * the post-operation environment.
 */
export function releaseInstallTerminalForFsOp(installationId: string): void {
  closeInstallPopouts(installationId)
  disposeTerminal(installationId)
}
