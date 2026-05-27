import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useDialogs } from './useDialogs'

/**
 * Guard that checks whether another local ComfyUI instance is already running
 * before launching a new one, and prompts the user for how to proceed.
 */
export function useLocalInstanceGuard() {
  const { t } = useI18n()
  const sessionStore = useSessionStore()
  const installationStore = useInstallationStore()
  const dialogs = useDialogs()

  /**
   * Check if another local instance is running before launching.
   * Returns true if launch should proceed, false if cancelled.
   * If the user chooses to replace, the running instance(s) are stopped before returning.
   */
  async function checkBeforeLaunch(targetId: string): Promise<boolean> {
    const target = installationStore.installations.find((i) => i.id === targetId)
    if (target && target.sourceCategory !== 'local') return true

    const runningLocal: { id: string; name: string }[] = []
    for (const [id, instance] of sessionStore.runningInstances) {
      if (id === targetId) continue
      const inst = installationStore.installations.find((i) => i.id === id)
      if (!inst || inst.sourceCategory === 'local') {
        runningLocal.push({ id, name: instance.installationName })
      }
    }
    for (const [id, instance] of sessionStore.launchingInstances) {
      if (id === targetId) continue
      const inst = installationStore.installations.find((i) => i.id === id)
      if (!inst || inst.sourceCategory === 'local') {
        runningLocal.push({ id, name: instance.installationName })
      }
    }

    if (runningLocal.length === 0) return true

    const names = runningLocal.map((r) => r.name).join(', ')

    // Two non-cancel actions in the footer — `secondary` is "Close
    // Running & Launch" (destructive: stops the other instance),
    // `primary` is "Launch Alongside" (additive). Header ✕ carries
    // the dismiss affordance since the footer is full.
    const choice = await dialogs.confirm({
      title: t('launch.instanceRunningTitle'),
      message: t('launch.instanceRunningMessage', { name: names }),
      confirmLabel: t('launch.instanceRunningProceed'),
      tone: 'primary',
      secondaryLabel: t('launch.instanceRunningReplace'),
      secondaryTone: 'danger',
      showCancel: false,
      showCloseIcon: true,
    })

    if (choice === 'secondary') {
      await Promise.all(runningLocal.map((r) => window.api.stopComfyUI(r.id)))
      return true
    }

    return choice === 'primary'
  }

  return { checkBeforeLaunch }
}
