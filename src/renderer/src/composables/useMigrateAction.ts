import { toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { useSessionStore } from '../stores/sessionStore'
import { augmentMessageWithStopWarning } from '../lib/stopWarning'
import { findBestVariant } from '../lib/variants'
import type { Installation, FieldOption, SnapshotDetailData } from '../types/ipc'

export interface MigrateActionResult {
  snapshotPath?: string
  enablePipSync: boolean
  target?: {
    mode: 'selected'
    release: FieldOption
    variant: FieldOption
  }
  [key: string]: unknown
}

interface MigrateConfirmOptions {
  title?: string
  message?: string
  confirmLabel?: string
}

/** Host-registered takeover surface for the brand-wrapped Migrate confirm.
 *  PanelApp sets this once on mount; `useMigrateAction` calls into it
 *  when invoked with `surface: 'takeover'`. */
export interface MigrateTakeoverSurface {
  open: (title: string, confirmLabel: string) => Promise<{
    confirmed: boolean
    checkboxValues: Record<string, boolean>
  }>
  update: (opts: {
    loading?: boolean
    preview?: SnapshotDetailData
    details?: { label: string; items: string[] }[]
    checkboxes?: { id: string; label: string; checked: boolean }[]
  }) => void
}

let registeredTakeover: MigrateTakeoverSurface | null = null

export function registerMigrateTakeover(surface: MigrateTakeoverSurface | null): void {
  registeredTakeover = surface
}

/**
 * Composable that encapsulates the full migration confirmation flow:
 * action guard → preview → confirm with variant/device selection → return data.
 *
 * Used by MigrationBanner (Dashboard), DetailModal (Installs → Manage),
 * useComfyUISettings (Settings drawer), and useFirstUseChain (first-use
 * takeover) to ensure a single code path for all migration entry points.
 * The render surface (`modal` vs the brand `takeover`) is fixed when the
 * composable is set up — passing it per-call risked drift across the
 * three modal callsites if the takeover variant ever grew extra fields.
 */
export function useMigrateAction(opts?: { surface?: 'modal' | 'takeover' }) {
  const { t } = useI18n()
  const modal = useModal()
  const actionGuard = useActionGuard()
  const sessionStore = useSessionStore()
  const surface: 'modal' | 'takeover' = opts?.surface ?? 'modal'

  /**
   * Run the migration confirmation flow for an installation.
   * Returns the data payload to pass to `runAction`, or `null` if cancelled.
   */
  async function confirmMigration(
    installation: Installation,
    confirm?: MigrateConfirmOptions,
  ): Promise<MigrateActionResult | null> {
    // Pre-flight busy check.
    if (!await actionGuard.checkBeforeAction(installation.id, t('migrate.migrateToStandalone'))) {
      return null
    }

    const useTakeover = surface === 'takeover' && registeredTakeover !== null
    const takeover = useTakeover ? registeredTakeover! : null
    const wasRunning = sessionStore.isRunning(installation.id)

    const isDesktop = installation.sourceId === 'desktop'

    const dialogTitle = confirm?.title || t('migrate.migrateToStandaloneConfirmTitle')
    const dialogConfirmLabel = confirm?.confirmLabel || t('migrate.migrateToStandaloneConfirm')
    const dialogMessage = wasRunning
      ? augmentMessageWithStopWarning(confirm?.message, t('errors.willStopRunning', { name: installation.name || 'ComfyUI' }))
      : confirm?.message || ''

    // Desktop adoption reuses the legacy data folder, Python env, and
    // models in place — no snapshot to preview, no variant to pick. A
    // plain confirm is the whole UI; main returns the freshly-adopted
    // installation id.
    if (isDesktop) {
      const desktopItems = [
        t('desktop.copyUserData'),
        t('desktop.copyInput'),
        t('desktop.copyOutput'),
        t('desktop.addModels'),
      ]
      const desktopDetails = wasRunning
        ? [{ label: t('migrate.migrationWill'), items: [t('errors.willStopRunning', { name: installation.name || 'ComfyUI' }), ...desktopItems] }]
        : [{ label: t('migrate.migrationWill'), items: desktopItems }]
      let confirmed: boolean
      if (takeover) {
        const surfacePromise = takeover.open(dialogTitle, dialogConfirmLabel)
        takeover.update({ loading: false, details: desktopDetails, checkboxes: [] })
        confirmed = (await surfacePromise).confirmed
      } else {
        confirmed = await modal.confirm({
          title: dialogTitle,
          message: dialogMessage,
          messageDetails: desktopDetails,
          confirmLabel: dialogConfirmLabel,
          confirmStyle: 'primary',
        })
      }
      if (!confirmed) return null
      return { enablePipSync: false }
    }

    const migrateItems = [
      t('migrate.mergeUserData'),
      t('migrate.mergeInput'),
      t('migrate.mergeOutput'),
      t('migrate.addModels'),
    ]

    // Show the surface (Modal OR brand takeover) with a loading state.
    // Both paths return the same { confirmed, checkboxValues } shape so
    // the rest of this function stays surface-agnostic.
    let surfacePromise: Promise<{ confirmed: boolean; checkboxValues: Record<string, boolean> }>
    if (takeover) {
      surfacePromise = takeover.open(dialogTitle, dialogConfirmLabel)
    } else {
      const modalConfirmPromise = modal.confirm({
        title: dialogTitle,
        message: dialogMessage,
        loading: true,
        confirmLabel: dialogConfirmLabel,
        confirmStyle: 'primary',
      })
      surfacePromise = modalConfirmPromise.then((confirmed) => ({
        confirmed,
        checkboxValues: modal.getLastCheckboxValues(),
      }))
    }

    // Fetch the preview in the background
    let previewResult: Awaited<ReturnType<typeof window.api.previewLocalMigration>>
    try {
      previewResult = await window.api.previewLocalMigration(installation.id)
    } catch (err) {
      if (takeover) takeover.update({ loading: false })
      else modal.close(false)
      await modal.alert({
        title: t('migrate.migrateToStandalone'),
        message: (err as Error)?.message ?? String(err),
      })
      return null
    }
    if (!previewResult.ok) {
      if (takeover) takeover.update({ loading: false })
      else modal.close(false)
      if (previewResult.message) {
        await modal.alert({ title: t('migrate.migrateToStandalone'), message: previewResult.message })
      }
      return null
    }

    const detailsPayload = wasRunning
      ? [
        { label: t('migrate.migrationWill'), items: [t('errors.willStopRunning', { name: installation.name || 'ComfyUI' }), ...migrateItems] },
      ]
      : [{ label: t('migrate.migrationWill'), items: migrateItems }]
    const checkboxesPayload = [{ id: 'enablePipSync', label: t('migrate.enablePipSync'), checked: false }]

    if (takeover) {
      takeover.update({
        loading: false,
        preview: previewResult.preview?.newestSnapshot,
        details: detailsPayload,
        checkboxes: checkboxesPayload,
      })
    } else {
      // Update the modal with the loaded preview data. The device-picker
      // UI was dropped per CTO ask — the device hasn't changed since the
      // prior install, so we silently pre-pick the recommended variant
      // below and submit it as part of the result payload.
      modal.updateConfirm({
        loading: false,
        snapshotPreview: previewResult.preview?.newestSnapshot,
        messageDetails: detailsPayload,
        checkboxes: checkboxesPayload,
      })
    }

    // Fetch release + variant options. The variant cards used to be
    // surfaced to the user; now `findBestVariant` silently picks the
    // recommended one and `result.target` carries it through to
    // `runAction('migrate-to-standalone', …)` unchanged.
    let migrateRelease: FieldOption | null = null
    let autoPickedVariant: FieldOption | null = null
    try {
      const releaseOptions = await window.api.getFieldOptions('standalone', 'release', {})
      migrateRelease = releaseOptions[0] || null
      if (migrateRelease) {
        const variantOptions = await window.api.getFieldOptions('standalone', 'variant', { release: toRaw(migrateRelease) })
        const snapshotVariantId = previewResult.preview?.newestSnapshot.comfyui.variant || ''
        autoPickedVariant = findBestVariant(variantOptions, snapshotVariantId)
      }
    } catch {
      /* swallow */
    }

    const { confirmed, checkboxValues } = await surfacePromise
    if (!confirmed) return null

    const result: MigrateActionResult = {
      snapshotPath: previewResult.snapshotPath,
      enablePipSync: !!checkboxValues.enablePipSync,
    }
    if (autoPickedVariant && migrateRelease) {
      result.target = {
        mode: 'selected',
        release: toRaw(migrateRelease),
        variant: toRaw(autoPickedVariant),
      }
    }

    return result
  }

  return { confirmMigration }
}
