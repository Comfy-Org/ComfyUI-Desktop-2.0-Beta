import type { InstallationRecord } from '../shared'

export interface ActionContext {
  event: Electron.IpcMainInvokeEvent
  installationId: string
  inst: InstallationRecord
  actionData?: Record<string, unknown>
}

export interface ActionResult {
  ok: boolean
  message?: string
  navigate?: string
  running?: boolean
  cancelled?: boolean
  mode?: string
  port?: number
  url?: string
  portConflict?: Record<string, unknown>
  /** Set by actions that produce a new install record (copy /
   *  copy-update / release-update) so the renderer can open A' in its
   *  own window. The source install's host stays put — never swapped. */
  newInstallationId?: string
}
