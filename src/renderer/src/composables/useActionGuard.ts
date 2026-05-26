import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useModal } from './useModal'

/**
 * Guard for in-progress operations. Returns true if the action should
 * proceed, false if the user cancelled. The stop-running concern is
 * handled inside each action's own confirm/prompt copy (augmented with
 * `errors.willStopRunning` when relevant) and the apiCall wrapper that
 * stops ComfyUI before running the op — no separate stop-confirm modal.
 */
export function useActionGuard() {
  const { t } = useI18n()
  const sessionStore = useSessionStore()
  const progressStore = useProgressStore()
  const modal = useModal()

  async function checkBeforeAction(installationId: string, actionLabel: string): Promise<boolean> {
    const activeSession = sessionStore.activeSessions.get(installationId)
    const isBusy = sessionStore.isLaunching(installationId) || (activeSession && !sessionStore.isRunning(installationId))
    if (isBusy) {
      const operation = activeSession?.label || t('running.title')
      const confirmed = await modal.confirm({
        title: actionLabel,
        message: t('errors.operationInProgress', { operation }),
        confirmLabel: t('errors.cancelOperation'),
        confirmStyle: 'danger',
      })
      if (!confirmed) return false
      await window.api.cancelOperation(installationId)
      // Wait for the cancelled op to clear instead of guessing how long
      // teardown takes — mirrors `stopAndWaitForExit`. The deadline is
      // generous because Windows taskkill / Restart Manager can be slow;
      // the next action would race the cancel without it.
      const deadline = Date.now() + 10_000
      while (
        (progressStore.getProgressInfo(installationId) !== null || sessionStore.isStopping(installationId)) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }

    return true
  }

  return { checkBeforeAction }
}
