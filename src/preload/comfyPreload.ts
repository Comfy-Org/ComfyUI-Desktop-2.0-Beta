import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

export interface ComfyDownloadProgress {
  url: string
  filename: string
  directory?: string
  progress: number
  receivedBytes?: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSeconds?: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
  isImage?: boolean
}

export interface TerminalRestore {
  buffer: string[]
  size: { cols: number; rows: number }
  exited: boolean
}

/**
 * Interactive terminal bridge for the served ComfyUI frontend.
 *
 * The frontend has no idea which installation it belongs to; the main process
 * resolves that from the sending webContents, so every call here omits the
 * installationId. The session is per-install and shared across windows.
 */
const Terminal = {
  /** Spawn the shell if needed, register this view as a subscriber, and
   *  return the current scrollback/size/exited state. */
  subscribe: (): Promise<TerminalRestore> => ipcRenderer.invoke('terminal-subscribe', null),
  unsubscribe: (): Promise<void> => ipcRenderer.invoke('terminal-unsubscribe', null),
  write: (data: string): Promise<void> => ipcRenderer.invoke('terminal-write', null, data),
  resize: (cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal-resize', null, cols, rows),
  /** Kill the current shell (if any) and start a fresh one. */
  restart: (): Promise<TerminalRestore> => ipcRenderer.invoke('terminal-restart', null),
  onOutput: (callback: (data: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: { data: string }) =>
      callback(payload.data)
    ipcRenderer.on('terminal-output', handler)
    return () => ipcRenderer.removeListener('terminal-output', handler)
  },
  onExited: (callback: () => void): (() => void) => {
    const handler = () => callback()
    ipcRenderer.on('terminal-exited', handler)
    return () => ipcRenderer.removeListener('terminal-exited', handler)
  },
}

contextBridge.exposeInMainWorld('__comfyDesktop2', {
  downloadModel: (url: string, filename: string, directory: string): Promise<boolean> => {
    return ipcRenderer.invoke('desktop2-download-model', { url, filename, directory })
  },
  downloadAsset: (url: string, filename: string, authToken?: string): Promise<boolean> => {
    return ipcRenderer.invoke('desktop2-download-asset', { url, filename, authToken: authToken || undefined })
  },
  pauseDownload: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke('model-download-pause', { url })
  },
  resumeDownload: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke('model-download-resume', { url })
  },
  cancelDownload: (url: string): Promise<boolean> => {
    return ipcRenderer.invoke('model-download-cancel', { url })
  },
  onDownloadProgress: (
    callback: (data: ComfyDownloadProgress) => void
  ): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) =>
      callback(data as ComfyDownloadProgress)
    ipcRenderer.on('desktop2-download-progress', handler)
    return () => ipcRenderer.removeListener('desktop2-download-progress', handler)
  },
  reportTheme: (bg: string, text: string): void => {
    ipcRenderer.send('desktop2-theme-report', { bg, text })
  },
  Terminal,
})
