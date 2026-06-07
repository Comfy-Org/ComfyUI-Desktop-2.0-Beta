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
 * Main resolves the installationId from the sending webContents when no
 * explicit one is passed. The inline injection (running inside the
 * comfyView) omits it; the pop-out window passes its installationId
 * explicitly because its webContents isn't registered as a comfyView.
 * Per-install shared shell — multiple subscribers see the same output.
 */
const Terminal = {
  /** Spawn the shell if needed, register this view as a subscriber, and
   *  return the current scrollback/size/exited state. */
  subscribe: (installationId?: string): Promise<TerminalRestore> =>
    ipcRenderer.invoke('terminal-subscribe', installationId ?? null),
  unsubscribe: (installationId?: string): Promise<void> =>
    ipcRenderer.invoke('terminal-unsubscribe', installationId ?? null),
  write: (data: string, installationId?: string): Promise<void> =>
    ipcRenderer.invoke('terminal-write', installationId ?? null, data),
  resize: (cols: number, rows: number, installationId?: string): Promise<void> =>
    ipcRenderer.invoke('terminal-resize', installationId ?? null, cols, rows),
  /** Kill the current shell (if any) and start a fresh one. */
  restart: (installationId?: string): Promise<TerminalRestore> =>
    ipcRenderer.invoke('terminal-restart', installationId ?? null),
  /** Open a separate Electron window subscribed to the same shell. Main
   *  resolves the installationId from the caller's comfyView sender so
   *  the inline injection doesn't need to know its own ID. */
  openPopout: (): Promise<void> => ipcRenderer.invoke('terminal-popout-open', null),
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

export interface LogsRestore {
  installationId: string
  buffer: string[]
}

export interface LogsOutputMsg {
  installationId: string
  text: string
}

/**
 * Read-only logs bridge. Subscribes to the shared per-install log
 * broadcast that mirrors every `comfy-output` IPC send. Used by the
 * pop-out logs window and (eventually) any other surface that wants the
 * raw stdout/stderr stream without owning the launcher.
 */
const Logs = {
  /** Register as a subscriber and return the current ring-buffer
   *  contents for an immediate paint. Subsequent chunks arrive on
   *  the `onOutput` channel. */
  subscribe: (installationId?: string): Promise<LogsRestore> =>
    ipcRenderer.invoke('logs-subscribe', installationId ?? null),
  unsubscribe: (installationId?: string): Promise<void> =>
    ipcRenderer.invoke('logs-unsubscribe', installationId ?? null),
  /** Open a separate Electron window subscribed to the same broadcast.
   *  Main resolves the installationId from the caller's comfyView sender
   *  so the inline injection doesn't need to know its own ID. */
  openPopout: (): Promise<void> => ipcRenderer.invoke('logs-popout-open', null),
  onOutput: (callback: (msg: LogsOutputMsg) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: LogsOutputMsg) =>
      callback(payload)
    ipcRenderer.on('logs-output', handler)
    return () => ipcRenderer.removeListener('logs-output', handler)
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
  Logs,
})
