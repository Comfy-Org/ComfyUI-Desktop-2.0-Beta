export type QuitReason = 'none' | 'user-quit' | 'update-install'

let quitReason: QuitReason = 'none'

export function setQuitReason(reason: QuitReason): void {
  quitReason = reason
}

export function clearQuitReason(): void {
  quitReason = 'none'
}

export function getQuitReason(): QuitReason {
  return quitReason
}

export function isQuitInProgress(): boolean {
  return quitReason !== 'none'
}

export function isUpdateInstallQuit(): boolean {
  return quitReason === 'update-install'
}

/** Set once the OS signals the session is ending (Windows shutdown / restart /
 *  logoff, via `app.on('session-end')`). Guards the update install paths so we
 *  never spawn an installer the OS is about to kill mid-write — the corruption
 *  mode behind the "reinstall every shutdown" loop. Never reset: the process is
 *  on its way out. */
let sessionEnding = false

export function setSessionEnding(): void {
  sessionEnding = true
}

export function isSessionEnding(): boolean {
  return sessionEnding
}
