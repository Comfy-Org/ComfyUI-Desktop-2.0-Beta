import {
  ipcMain,
  installations, i18n,
  killByPort,
  findPidsByPort,
  removePortLock,
  REQUIRES_STOPPED,
  _onStop,
  _operationAborts, _runningSessions,
  _getPublicSessions,
  stopRunning,
} from './shared'
import { dispatchSessionAction } from './sessionActions'
import { recordIpcInvocation } from '../e2eOverrides'

export function registerSessionHandlers(): void {
  ipcMain.handle('stop-comfyui', async (_event, installationId?: string) => {
    recordIpcInvocation('stop-comfyui', installationId)
    if (installationId) {
      await stopRunning(installationId)
    } else {
      await stopRunning()
    }
    if (_onStop) _onStop({ installationId })
  })

  ipcMain.handle('get-running-instances', () => _getPublicSessions())

  ipcMain.handle('cancel-launch', () => {
    for (const [_id, abort] of _operationAborts) {
      abort.abort()
    }
    _operationAborts.clear()
  })

  ipcMain.handle('cancel-operation', (_event, installationId: string) => {
    recordIpcInvocation('cancel-operation', installationId)
    const abort = _operationAborts.get(installationId)
    if (abort) {
      abort.abort()
      _operationAborts.delete(installationId)
    }
  })

  ipcMain.handle('kill-port-process', async (_event, port: number) => {
    recordIpcInvocation('kill-port-process', port)
    removePortLock(port)
    await killByPort(port)
    await new Promise((r) => setTimeout(r, 500))
    const remaining = await findPidsByPort(port)
    return { ok: remaining.length === 0 }
  })

  ipcMain.handle('run-action', async (_event, installationId: string, actionId: string, actionData?: Record<string, unknown>) => {
    recordIpcInvocation('run-action', { installationId, actionId, actionData })
    const maybeInst = await installations.get(installationId)
    if (!maybeInst) return { ok: false, message: 'Installation not found.' }
    const inst = maybeInst
    if (REQUIRES_STOPPED.has(actionId) && _runningSessions.has(installationId)) {
      return { ok: false, message: i18n.t('errors.stopRequired'), running: true }
    }
    if (REQUIRES_STOPPED.has(actionId) && _operationAborts.has(installationId)) {
      // The string has an `{operation}` placeholder — substitute it with
      // the localized action label when we have one, falling back to the
      // raw action id so the user at least sees *something* (and the
      // renderer never paints the raw `{operation}` template, which was
      // the regression here).
      const labelKey = `actions.${actionId}`
      const label = i18n.t(labelKey)
      const operation = label === labelKey ? actionId : label
      return { ok: false, message: i18n.t('errors.operationInProgress', { operation }) }
    }

    return dispatchSessionAction({ event: _event, installationId, inst, actionData }, actionId)
  })
}
