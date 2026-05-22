import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'

/**
 * Confirms quitting Desktop from the install-less chooser (dashboard) host.
 * Wired into the renderer's `onCloseRequest` handler so the ✕ on an idle
 * dashboard window pops a confirmation instead of closing silently.
 */
export function useQuitDesktopConfirm() {
  const { t } = useI18n()
  const modal = useModal()

  async function confirmQuitDesktop(): Promise<boolean> {
    return modal.confirm({
      title: t('dashboard.confirmQuit.title'),
      message: t('dashboard.confirmQuit.message'),
      confirmLabel: t('dashboard.confirmQuit.confirmLabel'),
      confirmStyle: 'danger',
    })
  }

  return { confirmQuitDesktop }
}
