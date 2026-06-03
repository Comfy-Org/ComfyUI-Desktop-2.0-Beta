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
      // Skip if the same install already came in via runningInstances
      // above — an install in the brief overlap between "launching" and
      // "running" would otherwise list (and close) twice.
      if (runningLocal.some((r) => r.id === id)) continue
      const inst = installationStore.installations.find((i) => i.id === id)
      if (!inst || inst.sourceCategory === 'local') {
        runningLocal.push({ id, name: instance.installationName })
      }
    }

    if (runningLocal.length === 0) return true

    // Show the full list of instances that will be stopped via a
    // structured detail block (mirrors the Quit Desktop confirm pattern
    // in main/host/detach.ts → confirmAndCloseAllHostWindows). Inline
    // `Close "{name}"` text was misleading once 2+ instances were
    // running because it visually emphasized one name even though the
    // primary action stopped them all.
    //
    // Two non-cancel actions in the footer. The primary (rightmost) is
    // "Close & Launch" — the expected path when the user wants to
    // switch instances; the secondary is "Run All" (additive: runs them
    // all side by side). Header ✕ carries the dismiss affordance since
    // the footer is full. Both use brand tones (no red) — closing the
    // prior instance to launch a new one is normal, not destructive.
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

    // Primary → close the running instance(s), then launch.
    // `stopComfyUI` awaits the actual process kill so the port is free
    // before the new launch starts; `closeComfyWindow({ skipConfirm })`
    // then retires the host window so the user doesn't get left on
    // ComfyLifecycleView's stopped surface for an instance they didn't
    // choose to revisit. The close call is fire-and-forget — its
    // teardown can't gate the launch because a concurrent OS-X close
    // handler with a pending user prompt could otherwise block it.
    // The `.catch` keeps an IPC reject (e.g. context-bridge disconnect)
    // from surfacing as an unhandled promise rejection in the renderer.
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
