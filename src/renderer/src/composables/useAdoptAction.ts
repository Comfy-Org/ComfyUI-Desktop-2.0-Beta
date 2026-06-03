import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { useSessionStore } from '../stores/sessionStore'
import { augmentMessageWithStopWarning } from '../lib/stopWarning'
import { getRegisteredMigrateTakeover } from './useMigrateAction'
import type { Installation } from '../types/ipc'

interface AdoptConfirmOptions {
  title?: string
  message?: string
  confirmLabel?: string
}

/**
 * Composable for the Legacy Desktop → Desktop 2.0 in-place adoption
 * confirm. Adoption reuses the legacy data folder, Python env, and models
 * verbatim — there's no snapshot to preview, no variant to pick, and no
 * pip-sync toggle. The UI is therefore a plain confirm (modal or brand
 * takeover) listing what will be reused in place; main returns the
 * freshly-adopted installation id.
 *
 * Lives in its own composable so {@link useMigrateAction} stays a single
 * standalone-migration code path; {@link useMigrateAction.confirmMigration}
 * delegates here when the install is a legacy desktop source.
 */
export function useAdoptAction(opts?: { surface?: 'modal' | 'takeover' }) {
  const { t } = useI18n()
  const modal = useModal()
  const actionGuard = useActionGuard()
  const sessionStore = useSessionStore()
  const surface: 'modal' | 'takeover' = opts?.surface ?? 'modal'

  /**
   * Run the adoption confirmation flow for a desktop-source installation.
   * Returns `true` if the user confirmed, `false` if cancelled, and
   * `null` if the action guard blocked entry (another op is in flight).
   */
  async function confirmAdoption(
    installation: Installation,
    confirm?: AdoptConfirmOptions,
  ): Promise<boolean | null> {
    if (!await actionGuard.checkBeforeAction(installation.id, t('migrate.migrateToStandalone'))) {
      return null
    }

    const registered = getRegisteredMigrateTakeover()
    const useTakeover = surface === 'takeover' && registered !== null
    const takeover = useTakeover ? registered! : null
    const wasRunning = sessionStore.isRunning(installation.id)

    const dialogTitle = confirm?.title || t('migrate.migrateToStandaloneConfirmTitle')
    const dialogConfirmLabel = confirm?.confirmLabel || t('migrate.migrateToStandaloneConfirm')
    const dialogMessage = wasRunning
      ? augmentMessageWithStopWarning(confirm?.message, t('errors.willStopRunning', { name: installation.name || 'ComfyUI' }))
      : confirm?.message || ''

    const reuseItems = [
      t('desktop.reuseUserData'),
      t('desktop.reuseInput'),
      t('desktop.reuseOutput'),
      t('desktop.addModels'),
    ]
    const details = wasRunning
      ? [{ label: t('migrate.migrationWill'), items: [t('errors.willStopRunning', { name: installation.name || 'ComfyUI' }), ...reuseItems] }]
      : [{ label: t('migrate.migrationWill'), items: reuseItems }]

    if (takeover) {
      const surfacePromise = takeover.open(dialogTitle, dialogConfirmLabel)
      takeover.update({ loading: false, details, checkboxes: [] })
      return (await surfacePromise).confirmed
    }
    return modal.confirm({
      title: dialogTitle,
      message: dialogMessage,
      messageDetails: details,
      confirmLabel: dialogConfirmLabel,
      confirmStyle: 'primary',
    })
  }

  return { confirmAdoption }
}
