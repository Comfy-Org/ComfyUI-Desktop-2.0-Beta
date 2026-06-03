import { BrowserWindow, ipcMain, shell } from 'electron'
import path from 'path'
import {
  cancelModelDownload,
  clearFinishedDownloads,
  dismissRecentDownload,
  getAllDownloads,
  pauseModelDownload,
  resumeModelDownload,
  retryDownload,
  startModelDownload,
} from '../comfyDownloadManager'

export function registerDownloadHandlers(): void {
  ipcMain.handle(
    'desktop2-download-model',
    (event, { url, filename, directory }: { url: string; filename: string; directory: string }) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      return startModelDownload(win, url, filename, directory, event.sender)
    },
  )

  ipcMain.handle('model-download-pause', (_event, { url }: { url: string }) =>
    pauseModelDownload(url),
  )

  ipcMain.handle('model-download-resume', (_event, { url }: { url: string }) =>
    resumeModelDownload(url),
  )

  ipcMain.handle('model-download-cancel', (_event, { url }: { url: string }) =>
    cancelModelDownload(url),
  )

  ipcMain.handle('model-download-dismiss', (_event, { url }: { url: string }) =>
    dismissRecentDownload(url),
  )

  ipcMain.handle('model-download-clear-finished', () => clearFinishedDownloads())

  ipcMain.handle('model-download-retry', (_event, { url }: { url: string }) => retryDownload(url))

  // Seed the renderer-side store with active entries plus the recent
  // terminal buffer so the Settings tab + popup history are non-empty
  // on first paint after a window opens mid-flow.
  ipcMain.handle('model-download-list', () => getAllDownloads())

  ipcMain.handle('show-download-in-folder', (_event, { savePath }: { savePath: string }) => {
    if (typeof savePath === 'string' && savePath) {
      shell.showItemInFolder(path.resolve(savePath))
    }
  })
}
