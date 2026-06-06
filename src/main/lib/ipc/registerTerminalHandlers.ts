import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { findInstallationIdByComfySender } from '../../host/registry'
import {
  subscribeTerminal,
  unsubscribeTerminal,
  writeTerminal,
  resizeTerminal,
  restartTerminal,
  getTerminalRestore,
  type TerminalRestore,
} from '../terminal'

/**
 * IPC for the interactive per-installation console.
 *
 * Two kinds of caller share these channels:
 *   - The desktop renderer (Settings "Console" tab), which knows the
 *     installationId and passes it explicitly.
 *   - The served ComfyUI frontend inside a comfyView, which does NOT know its
 *     installationId — we resolve it from the sender via the host registry.
 *
 * Output/exit are pushed straight to the subscribing webContents, so the
 * frontend never needs to know its own installationId.
 */

const EMPTY_RESTORE: TerminalRestore = {
  buffer: [],
  size: { cols: 80, rows: 30 },
  exited: true,
}

function resolveInstallationId(
  event: IpcMainInvokeEvent,
  explicit: string | null | undefined,
): string | null {
  if (explicit) return explicit
  return findInstallationIdByComfySender(event.sender)
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    'terminal-subscribe',
    async (event, installationId?: string | null): Promise<TerminalRestore> => {
      const id = resolveInstallationId(event, installationId)
      if (!id) return EMPTY_RESTORE
      return subscribeTerminal(id, event.sender)
    },
  )

  ipcMain.handle('terminal-unsubscribe', (event, installationId?: string | null) => {
    const id = resolveInstallationId(event, installationId)
    if (id) unsubscribeTerminal(id, event.sender)
  })

  ipcMain.handle('terminal-write', (event, installationId: string | null, data: string) => {
    const id = resolveInstallationId(event, installationId)
    if (id) writeTerminal(id, data)
  })

  ipcMain.handle(
    'terminal-resize',
    (event, installationId: string | null, cols: number, rows: number) => {
      const id = resolveInstallationId(event, installationId)
      if (id) resizeTerminal(id, cols, rows)
    },
  )

  ipcMain.handle(
    'terminal-restart',
    async (event, installationId?: string | null): Promise<TerminalRestore> => {
      const id = resolveInstallationId(event, installationId)
      if (!id) return EMPTY_RESTORE
      return restartTerminal(id)
    },
  )

  ipcMain.handle(
    'terminal-restore',
    (event, installationId?: string | null): TerminalRestore => {
      const id = resolveInstallationId(event, installationId)
      if (!id) return EMPTY_RESTORE
      return getTerminalRestore(id) ?? EMPTY_RESTORE
    },
  )
}
