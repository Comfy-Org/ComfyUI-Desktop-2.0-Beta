import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { useLocalInstanceGuard } from './useLocalInstanceGuard'
import { useSessionStore } from '../stores/sessionStore'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import { REQUIRES_STOPPED } from '../types/ipc'
import type { Installation, ListAction, ActionResult } from '../types/ipc'

export interface ListActionCallbacks {
  showProgress: (opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
  }) => void
  onNavigate?: (result: ActionResult, action: ListAction) => void | Promise<void>
}

export function useListAction(uiSurface: string, callbacks: ListActionCallbacks) {
  const modal = useModal()
  const actionGuard = useActionGuard()
  const localInstanceGuard = useLocalInstanceGuard()
  const sessionStore = useSessionStore()

  async function executeAction(inst: Installation, action: ListAction): Promise<void> {
    const telemetryContext = {
      source_category: inst.sourceCategory || 'unknown',
      ui_surface: uiSurface,
    }

    if (action.enabled === false && action.disabledMessage) {
      await modal.alert({ title: action.label, message: action.disabledMessage })
      return
    }

    // Pre-flight: check if the installation is busy or running
    if (REQUIRES_STOPPED.has(action.id)) {
      if (!await actionGuard.checkBeforeAction(inst.id, action.label)) return
    }

    if (action.confirm) {
      const confirmed = await modal.confirm({
        title: action.confirm.title || 'Confirm',
        message: action.confirm.message || 'Are you sure?',
        confirmLabel: action.label,
        confirmStyle: action.style || 'danger',
      })
      if (!confirmed) {
        emitTelemetryAction('launcher.action.result', { action_id: action.id, result: 'cancelled', ...telemetryContext })
        return
      }
    }

    if (action.id === 'launch') {
      const canLaunch = await localInstanceGuard.checkBeforeLaunch(inst.id)
      if (!canLaunch) {
        emitTelemetryAction('launcher.action.result', { action_id: action.id, result: 'cancelled', ...telemetryContext })
        return
      }
    }

    sessionStore.clearErrorInstance(inst.id)
    emitTelemetryAction('launcher.action.invoked', { action_id: action.id, ...telemetryContext })

    if (action.showProgress) {
      callbacks.showProgress({
        installationId: inst.id,
        title: `${action.progressTitle || action.label} — ${inst.name}`,
        apiCall: () => window.api.runAction(inst.id, action.id),
        cancellable: !!action.cancellable,
      })
      return
    }

    try {
      const result = await window.api.runAction(inst.id, action.id)
      if (result.running) {
        await actionGuard.checkBeforeAction(inst.id, action.label)
        return
      }
      const resultValue = result.cancelled ? 'cancelled' : (result.ok === false ? 'failed' : 'ok')
      emitTelemetryAction('launcher.action.result', { action_id: action.id, result: resultValue, ...telemetryContext })
      if (callbacks.onNavigate) {
        await callbacks.onNavigate(result, action)
      } else if (result.message) {
        await modal.alert({ title: action.label, message: result.message })
      }
    } catch (error: unknown) {
      emitTelemetryAction('launcher.action.result', {
        action_id: action.id,
        result: 'failed',
        error_bucket: toErrorBucket(error),
        ...telemetryContext,
      })
      throw error
    }
  }

  return { executeAction }
}
