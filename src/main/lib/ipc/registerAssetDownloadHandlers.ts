import { BrowserWindow, ipcMain } from 'electron'
import { get as getInstallation } from '../../installations'
import type { InstallationRecord } from '../../installations'
import * as settings from '../../settings'
import { startAssetDownload } from '../comfyDownloadManager'

/**
 * IPC handler that lets the panel renderer push asset URLs into the
 * shared download manager so they land in the install's output folder.
 */

function resolveOutputDir(inst: InstallationRecord): string | null {
  if ((inst.autoDownloadOutputs as boolean | undefined) === false) return null
  if ((inst.useSharedOutputDir as boolean | undefined) !== false) {
    return (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
  }
  const custom = inst.outputDir as string | undefined
  return custom && custom.trim() !== '' ? custom : (settings.get('outputDir') as string | undefined) || settings.defaults.outputDir
}

export function registerAssetDownloadHandlers(opts: {
  findInstallationIdForWindow: (win: BrowserWindow) => string | undefined
}): void {
  ipcMain.handle(
    'desktop2-download-asset',
    async (event, { url, filename, authToken }: { url: string; filename: string; authToken?: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      const installationId = opts.findInstallationIdForWindow(win)
      if (!installationId) return false
      const inst = await getInstallation(installationId)
      if (!inst) return false
      const outputDir = resolveOutputDir(inst)
      if (!outputDir) return false
      return startAssetDownload(win, url, filename, outputDir, authToken, event.sender)
    },
  )
}
