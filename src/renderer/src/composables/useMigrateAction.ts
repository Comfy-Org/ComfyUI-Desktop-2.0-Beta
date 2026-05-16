import { toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
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
 * Used by both MigrationBanner (Dashboard) and DetailModal (Installs → Manage)
 * to ensure a single code path for all migration entry points.
 */
export function useMigrateAction() {
  const { t } = useI18n()
  const modal = useModal()
  const actionGuard = useActionGuard()

  /**
   * Run the migration confirmation flow for an installation.
   * Returns the data payload to pass to `runAction`, or `null` if cancelled.
   */
  async function confirmMigration(
    installation: Installation,
    confirm?: MigrateConfirmOptions,
    opts?: { surface?: 'modal' | 'takeover' },
  ): Promise<MigrateActionResult | null> {
    // Pre-flight: check if the installation is busy or running
    if (!await actionGuard.checkBeforeAction(installation.id, t('migrate.migrateToStandalone'))) {
      return null
    }

    const useTakeover = opts?.surface === 'takeover' && registeredTakeover !== null
    const takeover = useTakeover ? registeredTakeover! : null

    const isDesktop = installation.sourceId === 'desktop'
    const migrateItems = isDesktop
      ? [
        t('desktop.copyUserData'),
        t('desktop.copyInput'),
        t('desktop.copyOutput'),
        t('desktop.addModels'),
      ]
      : [
        t('migrate.mergeUserData'),
        t('migrate.mergeInput'),
        t('migrate.mergeOutput'),
        t('migrate.addModels'),
      ]

    const dialogTitle = confirm?.title || t('migrate.migrateToStandaloneConfirmTitle')
    const dialogConfirmLabel = confirm?.confirmLabel || t('migrate.migrateToStandaloneConfirm')

    // Show the surface (Modal OR brand takeover) with a loading state.
    // Both paths return the same { confirmed, checkboxValues } shape so
    // the rest of this function stays surface-agnostic.
    let surfacePromise: Promise<{ confirmed: boolean; checkboxValues: Record<string, boolean> }>
    if (takeover) {
      surfacePromise = takeover.open(dialogTitle, dialogConfirmLabel)
    } else {
      const modalConfirmPromise = modal.confirm({
        title: dialogTitle,
        message: confirm?.message || '',
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
    let previewResult: Awaited<ReturnType<typeof window.api.previewDesktopMigration>>
    try {
      previewResult = isDesktop
        ? await window.api.previewDesktopMigration()
        : await window.api.previewLocalMigration(installation.id)
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

    const detailsPayload = [{ label: t('migrate.migrationWill'), items: migrateItems }]
    const checkboxesPayload = isDesktop
      ? []
      : [{ id: 'enablePipSync', label: t('migrate.enablePipSync'), checked: false }]

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
