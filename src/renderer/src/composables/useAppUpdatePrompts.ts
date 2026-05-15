import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'

/**
 * Title-bar app-update pill prompts. The pill click is routed by main
 * on `panel-trigger-overlay`; the panel renderer pops a confirm modal
 * here rather than a Tier 1 overlay so the spec's "modal" wording maps
 * to actual modal chrome.
 */
export function useAppUpdatePrompts(): {
  showAppUpdateRestartPrompt: (version: string | null) => Promise<void>
  showAppUpdateDownloadPrompt: (version: string | null) => Promise<void>
} {
  const { t } = useI18n()
  const modal = useModal()

  /** Falls back to "this update" when no version is known so the message reads
   *  cleanly in the (rare) version-less event payload. */
  function versionLabel(version: string | null): string {
    return version ? `v${version}` : t('appUpdate.fallbackVersion')
  }

  /**
   * "Desktop Update Ready" confirm modal. Fired by the title-bar pill
   * click when the cached state is `'ready'`, and automatically when an
   * auto-off user-initiated download finishes. Confirm → install &
   * relaunch (silent); cancel leaves the pill in place so the user can
   * trigger this prompt again later.
   */
  async function showAppUpdateRestartPrompt(version: string | null): Promise<void> {
    const ok = await modal.confirm({
      title: t('appUpdate.readyTitle'),
      message: t('appUpdate.readyMessage', { version: versionLabel(version) }),
      confirmLabel: t('appUpdate.restartNow'),
      confirmStyle: 'primary',
    })
    if (!ok) return
    await window.api.installUpdate()
  }

  /**
   * "Desktop Update Available" confirm modal. Fired by the title-bar pill
   * click when the cached state is `'available'` (only happens with
   * auto-updates OFF — main suppresses 'available' under auto-on).
   * Confirm → kick off the download; the auto restart-prompt fires on
   * `update-downloaded` to close the loop.
   */
  async function showAppUpdateDownloadPrompt(version: string | null): Promise<void> {
    const ok = await modal.confirm({
      title: t('appUpdate.availableTitle'),
      message: t('appUpdate.availableMessage', { version: versionLabel(version) }),
      confirmLabel: t('appUpdate.download'),
      confirmStyle: 'primary',
    })
    if (!ok) return
    await window.api.downloadUpdate()
  }

  return { showAppUpdateRestartPrompt, showAppUpdateDownloadPrompt }
}
