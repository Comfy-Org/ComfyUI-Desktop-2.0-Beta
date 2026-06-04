import { ipcMain } from 'electron'
import { getCrash } from '../crashBuffer'
import type { ComfyExitedData } from '../../../types/ipc'

// IPC reads from the per-install crash buffer; lets a recreated panel
// WebContents re-fetch the "still crashed after a refresh" detail.
export function registerCrashHandlers(): void {
  ipcMain.handle('get-last-crash-error', (_event, installationId: string): ComfyExitedData | null => {
    if (!installationId) return null
    return getCrash(installationId)
  })
}
