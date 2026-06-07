import {
  installations, i18n,
  sourceMap,
  _operationAborts,
} from '../shared'
import type { ActionContext, ActionResult } from './types'
import { appendLog } from '../../logsBroadcast'

export async function handleDelegateToSource({ event, installationId, inst, actionData }: ActionContext, actionId: string): Promise<ActionResult> {
  const abort = new AbortController()
  _operationAborts.set(installationId, abort)
  const sender = event.sender
  const sendProgress = (phase: string, detail: Record<string, unknown>): void => {
    try { if (!sender.isDestroyed()) sender.send('install-progress', { installationId, phase, ...detail }) } catch {}
  }
  const sendOutput = (text: string): void => {
    try { if (!sender.isDestroyed()) sender.send('comfy-output', { installationId, text }) } catch {}
    appendLog(installationId, text)
  }
  const update = (data: Record<string, unknown>): Promise<void> =>
    installations.update(installationId, data).then(() => {})
  const source = sourceMap[inst.sourceId]
  if (!source) {
    _operationAborts.delete(installationId)
    return { ok: false, message: i18n.t('errors.unknownSource') }
  }
  try {
    return await source.handleAction(actionId, inst, actionData, { update, sendProgress, sendOutput, signal: abort.signal })
  } catch (err) {
    if (abort.signal.aborted) return { ok: false, message: 'Cancelled' }
    return { ok: false, message: (err as Error).message }
  } finally {
    _operationAborts.delete(installationId)
  }
}
