import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { useLocalInstanceGuard } from './useLocalInstanceGuard'
import { useSessionStore } from '../stores/sessionStore'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import { progressOpKindForActionId, destroysInstanceForActionId } from '../lib/progressOpKind'
import {
  IN_PLACE_RELAUNCH,
  augmentMessageWithStopWarning,
  stopAndWaitForExit
} from '../lib/stopWarning'
import { REQUIRES_STOPPED } from '../types/ipc'
import type { Installation, ListAction, ActionResult, ShowProgressOpts } from '../types/ipc'

export interface ListActionCallbacks {
  showProgress: (opts: ShowProgressOpts) => void
  onNavigate?: (result: ActionResult, action: ListAction) => void | Promise<void>
}

/**
 * Per-call hooks for an `executeAction` invocation.
 *
 * `onGuardsPassed` fires exactly once, after every cancel-path
 * (disabled-message alert, busy guard, confirm modal, local-instance
 * guard) has resolved positively but BEFORE the action is actually
 * dispatched (either through `callbacks.showProgress` or the inline
 * `runAction` path). The chooser-host pick flow uses this to stake the
 * in-place attach claim only when the launch will really proceed —
 * staking earlier (before the guard) would cross-window overwrite a
 * sibling chooser's existing claim and leave the wrong window with the
 * preview / claim if the user cancels.
 */
export interface ListActionInvocationHooks {
  onGuardsPassed?: () => Promise<void> | void
}

export function useListAction(uiSurface: string, callbacks: ListActionCallbacks) {
  const { t } = useI18n()
  const modal = useModal()
  const actionGuard = useActionGuard()
  const localInstanceGuard = useLocalInstanceGuard()
  const sessionStore = useSessionStore()

  async function executeAction(
    inst: Installation,
    action: ListAction,
    hooks?: ListActionInvocationHooks
  ): Promise<void> {
    const telemetryContext = {
      source_category: inst.sourceCategory || 'unknown',
      ui_surface: uiSurface
    }

    if (action.enabled === false && action.disabledMessage) {
      await modal.alert({ title: action.label, message: action.disabledMessage })
      return
    }

    const requiresStoppedGuard =
      REQUIRES_STOPPED.has(action.id) && action.id !== 'migrate-to-standalone'
    const wasRunning = sessionStore.isRunning(inst.id)

    // Busy guard fires for every list-action runner so non-REQUIRES_STOPPED
    // entries (e.g. `launch`, `restart`, source-delegated actions) can't
    // race an in-flight op on the same install. The guard no-ops when
    // nothing is running.
    if (!(await actionGuard.checkBeforeAction(inst.id, action.label))) return

    if (action.confirm || (requiresStoppedGuard && wasRunning)) {
      const willStopMsg =
        requiresStoppedGuard && wasRunning
          ? t('errors.willStopRunning', { name: inst.name || 'ComfyUI' })
          : ''
      const baseMessage = action.confirm?.message
      const message = willStopMsg
        ? augmentMessageWithStopWarning(baseMessage, willStopMsg)
        : baseMessage || 'Are you sure?'
      const confirmed = await modal.confirm({
        title: action.confirm?.title || action.label,
        message,
        confirmLabel: action.label,
        confirmStyle: action.style || 'danger'
      })
      if (!confirmed) {
        emitTelemetryAction('comfy.desktop.action.result', {
          action_id: action.id,
          result: 'cancelled',
          ...telemetryContext
        })
        return
      }
    }

    if (action.id === 'launch') {
      const canLaunch = await localInstanceGuard.checkBeforeLaunch(inst.id)
      if (!canLaunch) {
        emitTelemetryAction('comfy.desktop.action.result', {
          action_id: action.id,
          result: 'cancelled',
          ...telemetryContext
        })
        return
      }
    }

    // Launch on a not-yet-adopted Legacy Desktop install funnels through
    // a migrate-then-launch chain instead — adoption is the prerequisite
    // for ComfyUI to actually run under Desktop 2.0. This path has its own
    // confirm + showProgress + early return, and skips onGuardsPassed
    // because the eventual launch is against a freshly-adopted
    // newInstallationId rather than this inst.id.
    if (action.id === 'launch' && inst.sourceId === 'desktop' && !inst.adopted) {
      const confirmed = await modal.confirm({
        title: t('desktop.migrateBeforeLaunchTitle'),
        message: t('desktop.migrateBeforeLaunchMessage'),
        confirmLabel: t('desktop.migrateBeforeLaunchConfirm'),
        confirmStyle: 'primary'
      })
      if (!confirmed) {
        emitTelemetryAction('comfy.desktop.action.result', {
          action_id: action.id,
          result: 'cancelled',
          ...telemetryContext
        })
        return
      }
      sessionStore.clearErrorInstance(inst.id)
      emitTelemetryAction('comfy.desktop.action.invoked', {
        action_id: action.id,
        ...telemetryContext
      })
      callbacks.showProgress({
        installationId: inst.id,
        title: `${t('desktop.migrating')} — ${inst.name}`,
        apiCall: async () => {
          const migrateResult = await window.api.runAction(inst.id, 'migrate-to-standalone')
          if (!migrateResult.ok || !migrateResult.newInstallationId) return migrateResult
          // Hand off to the freshly-adopted install in the same overlay
          // so the user sees one continuous "migrate → launch" flow.
          return window.api.runAction(migrateResult.newInstallationId, 'launch')
        },
        cancellable: true,
        triggersInstanceStart: true,
        opKind: 'launch'
      })
      return
    }

    // All cancel-paths have committed to running. Side effects that
    // must NOT survive a cancel (chooser in-place attach claim +
    // title-bar preview) belong in this hook.
    if (hooks?.onGuardsPassed) await hooks.onGuardsPassed()

    sessionStore.clearErrorInstance(inst.id)
    emitTelemetryAction('comfy.desktop.action.invoked', {
      action_id: action.id,
      ...telemetryContext
    })

    const needsSelfStop = wasRunning && requiresStoppedGuard
    const wantsRelaunch = needsSelfStop && IN_PLACE_RELAUNCH.has(action.id)
    const isRunning = (): boolean => sessionStore.isRunning(inst.id)

    if (action.showProgress) {
      // Tag launch / restart so PanelApp's `handleShowProgress` installs
      // the chooser-host close-on-instance-started subscription AND
      // routes through the brand-chrome takeover when the source is an
      // install-less chooser host. Mirrors DetailModal's flag.
      const triggersInstanceStart =
        action.id === 'launch' || action.id === 'restart' || wantsRelaunch
      const apiCall = needsSelfStop
        ? async () => {
            await stopAndWaitForExit(inst.id, isRunning)
            const result = await window.api.runAction(inst.id, action.id)
            if (wantsRelaunch && result?.ok !== false) {
              await window.api.runAction(inst.id, 'launch')
            }
            return result
          }
        : () => window.api.runAction(inst.id, action.id)
      callbacks.showProgress({
        installationId: inst.id,
        title: `${action.progressTitle || action.label} — ${inst.name}`,
        apiCall,
        cancellable: !!action.cancellable,
        triggersInstanceStart,
        opKind: progressOpKindForActionId(action.id),
        destroysInstance: destroysInstanceForActionId(action.id),
        actionId: action.id
      })
      return
    }

    try {
      if (needsSelfStop) {
        await stopAndWaitForExit(inst.id, isRunning)
      }
      const result = await window.api.runAction(inst.id, action.id)
      if (result.running) {
        await actionGuard.checkBeforeAction(inst.id, action.label)
        return
      }
      if (wantsRelaunch && result?.ok !== false) {
        await window.api.runAction(inst.id, 'launch')
      }
      const resultValue = result.cancelled ? 'cancelled' : result.ok === false ? 'failed' : 'ok'
      emitTelemetryAction('comfy.desktop.action.result', {
        action_id: action.id,
        result: resultValue,
        ...telemetryContext
      })
      if (callbacks.onNavigate) {
        await callbacks.onNavigate(result, action)
      } else if (result.message) {
        await modal.alert({ title: action.label, message: result.message })
      }
    } catch (error: unknown) {
      emitTelemetryAction('comfy.desktop.action.result', {
        action_id: action.id,
        result: 'failed',
        error_bucket: toErrorBucket(error),
        ...telemetryContext
      })
      throw error
    }
  }

  return { executeAction }
}
