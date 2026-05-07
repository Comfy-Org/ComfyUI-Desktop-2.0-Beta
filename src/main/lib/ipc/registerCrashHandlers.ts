import { ipcMain } from 'electron'
import { getCrash } from '../crashBuffer'
import type { ComfyExitedData } from '../../../types/ipc'

/**
 * Wire IPC handlers that read from the per-installation crash buffer.
 *
 * The buffer is the source of truth for the lifecycle view's "still
 * crashed after a refresh" state — the live `comfy-exited` event also
 * updates the renderer-side error map, but a panel WebContents that's
 * recreated (e.g. main switches the body view back from comfy-running
 * to lifecycle, or the user reloads the panel) needs to re-fetch the
 * detail to render the crashed body.
 */
export function registerCrashHandlers(): void {
  ipcMain.handle('get-last-crash-error', (_event, installationId: string): ComfyExitedData | null => {
    if (!installationId) return null
    return getCrash(installationId)
  })
}
