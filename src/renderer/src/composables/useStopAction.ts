import { useI18n } from 'vue-i18n'

/**
 * Shared "Stop ComfyUI" action — danger confirm, copy, and `stopComfyUI` with
 * error alerting — so the detail menu and the tile menu can't drift. Callers
 * inject pre-bound `confirm` / `alert` because they use different dialog
 * systems (`useDialogs` tone vs `useModal` confirmStyle).
 */
export interface StopActionDialogs {
  confirm: (opts: { title: string; message: string; confirmLabel: string }) => Promise<boolean | string>
  alert: (opts: { title: string; message: string }) => Promise<unknown>
}

export function useStopAction(dialogs: StopActionDialogs) {
  const { t } = useI18n()

  /** Returns `true` only when the stop actually ran, so callers can chain
   *  follow-up UI (e.g. dismissing the preview). */
  async function confirmAndStop(installationId: string): Promise<boolean> {
    const stopLabel = t('actions.stop', 'Stop')
    const confirmed = await dialogs.confirm({
      title: t('actions.stopConfirmTitle', 'Stop ComfyUI'),
      message: t(
        'actions.stopConfirmMessage',
        'This will stop ComfyUI. Any unsaved work will be lost. The window stays open so you can relaunch anytime.',
      ),
      confirmLabel: stopLabel,
    })
    if (!confirmed) return false
    try {
      await window.api.stopComfyUI(installationId)
      return true
    } catch (err) {
      await dialogs.alert({ title: stopLabel, message: (err as Error)?.message || String(err) })
      return false
    }
  }

  return { confirmAndStop }
}
