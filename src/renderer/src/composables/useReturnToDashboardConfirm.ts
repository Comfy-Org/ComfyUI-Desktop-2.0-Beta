import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import type { Installation } from '../types/ipc'

export type ReturnToDashboardReason = 'in_flight' | 'crashed' | 'stopped' | 'running'

/**
 * Confirms returning to the dashboard from an install-backed host.
 * Local installs are prompted (because returning stops ComfyUI); cloud/remote
 * installs resolve immediately since detach does not interrupt them.
 */
export function useReturnToDashboardConfirm() {
  const { t } = useI18n()
  const modal = useModal()

  async function confirmReturnToDashboard(
    installation: Installation | null | undefined,
    reason: ReturnToDashboardReason,
  ): Promise<boolean> {
    if (!installation || installation.sourceCategory !== 'local') return true
    // Already-idle states (stopped / crashed) have nothing to stop, so the
    // user can back out freely — skip the prompt copy that mentions
    // stopping ComfyUI.
    if (reason === 'stopped' || reason === 'crashed') return true
    return modal.confirm({
      title: t('dashboard.confirmStopLocal.title'),
      message: t('dashboard.confirmStopLocal.message'),
      confirmLabel: t('dashboard.confirmStopLocal.confirmLabel'),
      confirmStyle: 'danger',
    })
  }

  return { confirmReturnToDashboard }
}
