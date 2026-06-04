import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useDialogs } from './useDialogs'

// Prompts when another local instance is already running before a new launch.
export function useLocalInstanceGuard() {
  const { t } = useI18n()
  const sessionStore = useSessionStore()
  const installationStore = useInstallationStore()
  const dialogs = useDialogs()

  // Returns true to proceed, false if cancelled. On replace, stops the
  // running instance(s) before returning.
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
      // Skip installs already counted above, to avoid double-listing during
      // the launching→running overlap.
      if (runningLocal.some((r) => r.id === id)) continue
      const inst = installationStore.installations.find((i) => i.id === id)
      if (!inst || inst.sourceCategory === 'local') {
        runningLocal.push({ id, name: instance.installationName })
      }
    }

    if (runningLocal.length === 0) return true

    // Two non-cancel actions: primary "Close & Launch", secondary "Run All"
    // (side by side). Header ✕ is the dismiss since the footer is full.
    const choice = await dialogs.confirm({
      title: t('launch.instanceRunningTitle'),
      message: t('launch.instanceRunningMessage'),
      messageDetails: [
        { label: t('launch.instanceRunningListLabel'), items: runningLocal.map((r) => r.name) },
      ],
      confirmLabel: t('launch.instanceRunningReplace'),
      tone: 'primary',
      secondaryLabel: t('launch.instanceRunningProceed'),
      secondaryTone: 'default',
      showCancel: false,
      showCloseIcon: true,
    })

    // Primary → close then launch. `stopComfyUI` awaits the process kill so
    // the port is free; `closeComfyWindow` is fire-and-forget (its teardown
    // can't gate the launch) with a `.catch` to swallow IPC rejects.
    if (choice === 'primary') {
      await Promise.all(
        runningLocal.map(async (r) => {
          await window.api.stopComfyUI(r.id)
          window.api.closeComfyWindow(r.id, { skipConfirm: true }).catch((err) => {
            console.warn('useLocalInstanceGuard: closeComfyWindow failed', err)
          })
        }),
      )
      return true
    }

    // Secondary → launch alongside the running instance(s).
    return choice === 'secondary'
  }

  return { checkBeforeLaunch }
}
