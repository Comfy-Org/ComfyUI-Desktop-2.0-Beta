import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { findInstallationIdByComfySender } from '../../host/registry'
import { subscribeLogs, unsubscribeLogs, type LogsRestore } from '../logsBroadcast'
import { openLogsPopout } from '../logsPopoutWindow'

/**
 * IPC for the logs broadcast — the read-only counterpart of the
 * interactive terminal channels.
 *
 * Callers come in two shapes, same as the terminal IPC:
 *   - The desktop renderer (Console tab, future Logs panel) passes its
 *     installationId explicitly.
 *   - The injected ComfyUI bottom-panel Logs tab does not know its
 *     installationId; we resolve it from the sender via the comfyView
 *     registry.
 *
 * Subscribe returns the current ring-buffer contents so the caller can
 * paint immediately. Subsequent broadcasts arrive on `logs-output`.
 */

const EMPTY_RESTORE: LogsRestore = { installationId: '', buffer: [] }

function resolveInstallationId(
  event: IpcMainInvokeEvent,
  explicit: string | null | undefined,
): string | null {
  if (explicit) return explicit
  return findInstallationIdByComfySender(event.sender)
}

export function registerLogsHandlers(): void {
  ipcMain.handle(
    'logs-subscribe',
    (event, installationId?: string | null): LogsRestore => {
      const id = resolveInstallationId(event, installationId)
      if (!id) return EMPTY_RESTORE
      return subscribeLogs(id, event.sender)
    },
  )

  ipcMain.handle('logs-unsubscribe', (event, installationId?: string | null) => {
    const id = resolveInstallationId(event, installationId)
    if (id) unsubscribeLogs(id, event.sender)
  })

  // Pop the inline logs out into a standalone Electron window. Same
  // sender-resolution path as terminal-popout-open so the caller
  // (inline injection in the comfyView) never has to know its own id.
  ipcMain.handle(
    'logs-popout-open',
    async (event, installationId?: string | null): Promise<void> => {
      const id = resolveInstallationId(event, installationId)
      if (!id) return
      await openLogsPopout(id)
    },
  )
}
