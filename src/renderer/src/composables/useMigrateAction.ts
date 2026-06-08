import { toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { useAdoptAction } from './useAdoptAction'
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
  /** Skip the confirm UI entirely and resolve as soon as the preview +
   *  variant lookup finish. Used by the first-use chain when the user
   *  ticked Express Install alongside Migrate-existing — the express
   *  semantics ("skip optional setup, use recommended defaults") apply
   *  to the migrate path the same way they apply to a fresh install.
   *  Preflight failures (busy check, preview error, release lookup) still
   *  return null; only the user-facing confirm step is bypassed. */
  express?: boolean
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

/** Read access for sibling composables (e.g. {@link useAdoptAction}) that
 *  drive the same takeover. PanelApp only registers once. */
export function getRegisteredMigrateTakeover(): MigrateTakeoverSurface | null {
  return registeredTakeover
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
  const adoptAction = useAdoptAction(opts)
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
    // Desktop adoption is a different operation entirely — in-place reuse
    // of the legacy data folder, Python env, and models; no snapshot to
    // preview and no variant to pick. Delegate to the dedicated composable
    // so this function stays a single standalone-migration code path.
    if (installation.sourceId === 'desktop') {
      const confirmed = await adoptAction.confirmAdoption(installation, confirm)
      if (confirmed !== true) return null
      return { enablePipSync: false }
    }

    // Pre-flight busy check.
    if (!await actionGuard.checkBeforeAction(installation.id, t('migrate.migrateToStandalone'))) {
      return null
    }

    const isExpress = confirm?.express === true
    // Express-install path skips the user confirm surface entirely —
    // no takeover/modal is opened, the surface promise resolves
    // immediately as `confirmed: true` with default checkbox values.
    // Preview + variant lookup still run because runAction needs the
    // snapshotPath + target, and a failure on either still routes to
    // the same null return below.
    const useTakeover = !isExpress && surface === 'takeover' && registeredTakeover !== null
    const takeover = useTakeover ? registeredTakeover! : null
    const wasRunning = sessionStore.isRunning(installation.id)

    const dialogTitle = confirm?.title || t('migrate.migrateToStandaloneConfirmTitle')
    const dialogConfirmLabel = confirm?.confirmLabel || t('migrate.migrateToStandaloneConfirm')
    const dialogMessage = wasRunning
      ? augmentMessageWithStopWarning(confirm?.message, t('errors.willStopRunning', { name: installation.name || 'ComfyUI' }))
      : confirm?.message || ''

    const migrateItems = [
      t('migrate.mergeUserData'),
      t('migrate.mergeInput'),
      t('migrate.mergeOutput'),
      t('migrate.addModels'),
    ]

    // Show the surface (Modal OR brand takeover) with a loading state.
    // Both paths return the same { confirmed, checkboxValues } shape so
    // the rest of this function stays surface-agnostic. Express skips
    // the surface — the promise resolves to `confirmed: true` with the
    // checkbox defaults so the rest of this function reads the same
    // result shape downstream.
    let surfacePromise: Promise<{ confirmed: boolean; checkboxValues: Record<string, boolean> }>
    if (isExpress) {
      surfacePromise = Promise.resolve({ confirmed: true, checkboxValues: {} })
    } else if (takeover) {
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

    // Fetch the preview in the background. Express skips all surface
    // updates because no surface was opened — preflight failures still
    // alert the user (the chain handler would otherwise show no
    // feedback) but the success path simply moves on to release
    // lookup + the immediate confirmed resolve.
    let previewResult: Awaited<ReturnType<typeof window.api.previewLocalMigration>>
    try {
      previewResult = await window.api.previewLocalMigration(installation.id)
    } catch (err) {
      if (takeover) takeover.update({ loading: false })
      else if (!isExpress) modal.close(false)
      await modal.alert({
        title: t('migrate.migrateToStandalone'),
        message: (err as Error)?.message ?? String(err),
      })
      return null
    }
    if (!previewResult.ok) {
      if (takeover) takeover.update({ loading: false })
      else if (!isExpress) modal.close(false)
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
    } else if (!isExpress) {
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
      // `includeLatestStable: true` opens the standalone release list — same
      // gate the install wizard passes (`standalone/index.ts:328`). Without it
      // releaseOptions is empty, `migrateRelease` ends up null, and the
      // migrate flow silently gives up without picking a variant.
      const releaseOptions = await window.api.getFieldOptions('standalone', 'release', {}, { includeLatestStable: true })
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
