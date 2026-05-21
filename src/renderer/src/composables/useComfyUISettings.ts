import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useActionGuard } from './useActionGuard'
import { useMigrateAction } from './useMigrateAction'
import { useSessionStore } from '../stores/sessionStore'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import { progressOpKindForActionId } from '../lib/progressOpKind'
import {
  REQUIRES_STOPPED,
  type ActionDef,
  type DetailField,
  type DetailItem,
  type DetailSection,
  type DiskSpaceInfo,
  type FieldOption,
  type Installation,
  type ShowProgressOpts,
} from '../types/ipc'

/**
 * Backing state + IPC plumbing for the brand-redesigned Settings drawer
 * (`ComfyUISettingsPanel.vue`). Extracted into a composable so the
 * component stays UI-only — same convention as the title-bar
 * `useTitleBarMenus` / `usePanelOverlays` split.
 *
 * All four tabs source from `getDetailSections()` — the same payload
 * `DetailModal` reads — and writes through `update-installation` /
 * `runAction`. Disk Usage is a separate `get-disk-space` call merged
 * into the Status tab as a synthetic row.
 *
 * Action handling mirrors `DetailModal.runAction` exactly:
 *   1. REQUIRES_STOPPED guard via useActionGuard
 *   2. `migrate-to-standalone` special case → useMigrateAction
 *   3. fieldSelects chain → modal.select per fieldSelect
 *   4. select chain → modal.select (e.g. installations)
 *   5. prompt chain → modal.prompt
 *   6. confirm chain → modal.confirm or modal.confirmWithOptions
 *   7. disk-space check for copy / copy-update / release-update
 *   8. showProgress → opts.onShowProgress with synthetic-restart support
 *   9. inline → window.api.runAction with result navigation
 */

export interface UseComfyUISettingsOpts {
  /** Accept any reactive source — `Ref`, `ComputedRef`, or getter — so
   *  callers can pass `toRef(props, 'installation')` directly. */
  installation: MaybeRefOrGetter<Installation | null>
  /** Fires when an action requests a ProgressModal — the host
   *  (`PanelApp.vue`) already owns the modal and consumes this shape
   *  via `usePanelOverlays.handleShowProgress`. */
  onShowProgress: (opts: ShowProgressOpts) => void
  /** Fired when an action's `result.navigate === 'list'` — the install
   *  was removed (delete / untrack). The drawer host should close the
   *  drawer and tear down the comfy window — mirrors DetailModal's
   *  `emit('navigate-list')`. */
  onNavigateList?: () => void
  /** Fired alongside `onNavigateList` so the drawer can animate its
   *  own dismissal before the host completes the navigation — mirrors
   *  DetailModal's `emit('close')`. */
  onClose?: () => void
}

export interface UseComfyUISettingsApi {
  sections: Ref<DetailSection[]>
  diskSpace: Ref<DiskSpaceInfo | null>
  loading: Ref<boolean>
  error: Ref<string | null>

  /** Refresh sections + disk usage for the current installation. */
  reload: () => Promise<void>

  /** Per-section refresh (parity with legacy DetailModal). Splices
   *  only the named section in-place — leaves the other sections'
   *  Vue subtrees intact, so collapse state and internal scrolls
   *  survive the refresh. Falls back to full `reload()` when the
   *  title is missing or no longer in the new payload. */
  refreshSection: (sectionTitle: string | undefined) => Promise<void>

  /** Push a single field mutation through `update-installation` and
   *  reload sections so the UI tracks main-side defaults / clamping. */
  updateField: (field: DetailField, value: unknown) => Promise<void>

  /** Run an action coming off a `DetailSection.actions[]` entry. */
  runAction: (action: ActionDef) => Promise<void>

  /** Visible sections for a given tab (filtered by `section.tab`). */
  sectionsForTab: (tab: 'settings' | 'status' | 'update' | 'snapshots') => ComputedRef<DetailSection[]>

  /** Synthetic Status-tab row carrying the disk-usage reading. The
   *  status section payload doesn't include this — it lives on its own
   *  IPC — so the component renders it alongside the regular items. */
  diskUsageItem: ComputedRef<DetailItem | null>

  /** Install-level actions (`pinBottom` section from main). */
  pinBottomSection: ComputedRef<DetailSection | null>

  /** `pinBottomSection.actions` with the renderer-side Launch→Restart
   *  swap applied — when the install is running, `'launch'` becomes
   *  `'restart'` (confirm + stop→launch chain). Mirrors DetailModal's
   *  `bottomActions` computed exactly. */
  pinBottomActions: ComputedRef<ActionDef[]>
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function useComfyUISettings(opts: UseComfyUISettingsOpts): UseComfyUISettingsApi {
  const { t } = useI18n()
  const modal = useModal()
  const actionGuard = useActionGuard()
  const { confirmMigration } = useMigrateAction()
  const sessionStore = useSessionStore()

  const sections = ref<DetailSection[]>([])
  const diskSpace = ref<DiskSpaceInfo | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadAll(installationId: string, installPath: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [secs, disk] = await Promise.all([
        window.api.getDetailSections(installationId),
        installPath ? window.api.getDiskSpace(installPath).catch(() => null) : Promise.resolve(null),
      ])
      sections.value = secs
      diskSpace.value = disk
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  async function reload(): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) {
      sections.value = []
      diskSpace.value = null
      return
    }
    await loadAll(inst.id, inst.installPath ?? '')
  }

  /** Per-section refresh (parity with legacy DetailModal). Fetches
   *  the full sections payload but only splices the matching title
   *  in-place — leaves the other sections' Vue subtrees intact, which
   *  preserves things like collapse state and any internal scroll. */
  async function refreshSection(sectionTitle: string | undefined): Promise<void> {
    if (!sectionTitle) {
      await reload()
      return
    }
    const inst = toValue(opts.installation)
    if (!inst) return
    try {
      const fresh = await window.api.getDetailSections(inst.id)
      const updated = fresh.find((s) => s.title === sectionTitle)
      if (!updated) {
        // Title disappeared from the new payload — main mutated the
        // section list, so fall back to a full replace to stay coherent.
        sections.value = fresh
        return
      }
      const idx = sections.value.findIndex((s) => s.title === sectionTitle)
      if (idx >= 0) {
        sections.value.splice(idx, 1, updated)
      } else {
        sections.value = fresh
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function updateField(field: DetailField, value: unknown): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) return
    await window.api.updateInstallation(inst.id, { [field.id]: value })
    emitTelemetryAction('desktop2.settings.changed', {
      setting_key: field.id,
      value_kind: field.editType || 'text',
      bool_value: typeof value === 'boolean' ? value : undefined,
    })
    // Parity with legacy DetailSection: a field can declare an
    // `onChangeAction` to fire automatically after its value changes
    // (e.g. switching update channel triggers `check-update` so the
    // preview metadata refreshes without an extra click). Surface
    // failures via modal so the user can react.
    if (field.onChangeAction) {
      try {
        await window.api.runAction(inst.id, field.onChangeAction)
      } catch (err: unknown) {
        await modal.alert({
          title: t('common.error', 'Error'),
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // Parity with legacy DetailSection (PARITY-G): when a field opts
    // into `refreshSection`, splice only that section instead of
    // replacing the whole array — preserves Vue subtrees and collapse
    // state for sections the user wasn't touching.
    if (field.refreshSection) {
      const owningSection = sections.value.find(
        (s) => s.fields?.some((f) => f.id === field.id),
      )
      await refreshSection(owningSection?.title)
    } else {
      await reload()
    }
  }

  async function runAction(action: ActionDef): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) return

    const telemetryContext = { action_id: action.id }

    // 1. REQUIRES_STOPPED guard — actions that need ComfyUI stopped
    //    first (snapshot restore, release-update, …). migrate-to-
    //    standalone manages its own guard via useMigrateAction below.
    if (action.id !== 'migrate-to-standalone' && REQUIRES_STOPPED.has(action.id)) {
      const proceed = await actionGuard.checkBeforeAction(inst.id, action.label)
      if (!proceed) return
    }

    let mutableAction: ActionDef = { ...action }

    // 2. migrate-to-standalone — dedicated brand takeover registered by
    //    PanelApp via `registerMigrateTakeover`. Returns the form data
    //    (checkbox values, etc.) which we merge into the action data.
    if (mutableAction.id === 'migrate-to-standalone') {
      const migrateResult = await confirmMigration(inst, mutableAction.confirm)
      if (!migrateResult) return
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, ...migrateResult },
      }
    }

    // 3. fieldSelects chain — each step prompts the user to pick from a
    //    main-side source via `getFieldOptions`. Selections feed the
    //    next step + accumulate on `mutableAction.data`.
    if (mutableAction.fieldSelects) {
      const selections: Record<string, FieldOption> = {}
      for (const fs of mutableAction.fieldSelects) {
        let items: FieldOption[]
        try {
          items = await window.api.getFieldOptions(fs.sourceId, fs.fieldId, selections)
        } catch (err: unknown) {
          await modal.alert({
            title: mutableAction.label,
            message: (err as Error).message || String(err),
          })
          return
        }
        if (!items || items.length === 0) {
          await modal.alert({
            title: mutableAction.label,
            message: fs.emptyMessage || t('common.noItems'),
          })
          return
        }
        const selectItems = items.map((item) => ({
          value: item.value,
          label: (item.recommended ? '★ ' : '') + item.label,
          description: item.description,
        }))
        const selected = await modal.select({
          title: fs.title || mutableAction.label,
          message: fs.message || '',
          items: selectItems,
        })
        if (!selected) return
        const selectedItem = items.find((i) => i.value === selected)
        if (selectedItem) selections[fs.fieldId] = selectedItem
        mutableAction = {
          ...mutableAction,
          data: { ...mutableAction.data, [fs.field]: selectedItem },
        }
      }
    }

    // 4. select chain — single-shot select against a named source
    //    (e.g. `'installations'` for "copy from which install").
    if (mutableAction.select) {
      let items: { value: string; label: string; description?: string }[] | undefined
      if (mutableAction.select.source === 'installations') {
        let all = await window.api.getInstallations()
        if (mutableAction.select.excludeSelf) {
          all = all.filter((i) => i.id !== inst.id)
        }
        if (mutableAction.select.filters) {
          for (const [key, value] of Object.entries(mutableAction.select.filters)) {
            all = all.filter((i) => (i as Record<string, unknown>)[key] === value)
          }
        }
        items = all.map((i) => ({ value: i.id, label: i.name, description: i.sourceLabel }))
      }
      if (!items || items.length === 0) {
        await modal.alert({
          title: mutableAction.label,
          message: mutableAction.select.emptyMessage || t('common.noItems'),
        })
        return
      }
      const selected = await modal.select({
        title: mutableAction.select.title || mutableAction.label,
        message: mutableAction.select.message || '',
        items,
      })
      if (!selected) return
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, [mutableAction.select.field]: selected },
      }
    }

    // 5. prompt chain — free-form text input (e.g. Copy Installation
    //    new-name prompt).
    if (mutableAction.prompt) {
      const value = await modal.prompt({
        title: mutableAction.prompt.title || mutableAction.label,
        message: mutableAction.prompt.message || '',
        placeholder: mutableAction.prompt.placeholder,
        defaultValue: mutableAction.prompt.defaultValue,
        confirmLabel: mutableAction.prompt.confirmLabel || mutableAction.label,
        required: mutableAction.prompt.required,
        messageDetails: mutableAction.prompt.messageDetails,
      })
      if (!value) return
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, [mutableAction.prompt.field]: value },
      }
    }

    // 6. confirm chain — skip for migrate-to-standalone (handled in #2).
    //    `confirm.options` flips us to `confirmWithOptions` (checkbox
    //    confirm — e.g. Delete Installation's "Also delete files" toggle).
    if (mutableAction.confirm && mutableAction.id !== 'migrate-to-standalone') {
      if (mutableAction.confirm.options) {
        const result = await modal.confirmWithOptions({
          title: mutableAction.confirm.title || 'Confirm',
          message: mutableAction.confirm.message || 'Are you sure?',
          options: mutableAction.confirm.options,
          confirmLabel: mutableAction.confirm.confirmLabel || mutableAction.label,
          confirmStyle: mutableAction.style || 'danger',
        })
        if (!result) return
        mutableAction = { ...mutableAction, data: { ...mutableAction.data, ...result } }
      } else {
        const confirmed = await modal.confirm({
          title: mutableAction.confirm.title || 'Confirm',
          message: mutableAction.confirm.message || 'Are you sure?',
          messageDetails: mutableAction.confirm.messageDetails,
          confirmLabel: mutableAction.label,
          confirmStyle: mutableAction.style || 'danger',
        })
        if (!confirmed) return
      }
    }

    // 7. Disk-space sanity check for actions that write significant
    //    data. Estimate via `getInstallationSize` for copy / copy-update;
    //    fall back to a generic 1 GiB threshold otherwise.
    const diskCheckActions = new Set(['copy', 'copy-update', 'release-update'])
    if (diskCheckActions.has(mutableAction.id) && inst.installPath) {
      try {
        const space: DiskSpaceInfo = await window.api.getDiskSpace(inst.installPath)
        let estimatedRequired = 0
        if (mutableAction.id === 'copy' || mutableAction.id === 'copy-update') {
          try {
            const r = await window.api.getInstallationSize(inst.id)
            estimatedRequired = r.sizeBytes
          } catch {
            // ignore — fall through to generic threshold
          }
        }
        const threshold = estimatedRequired > 0 ? Math.ceil(estimatedRequired * 1.1) : 1073741824
        if (space.free < threshold) {
          const freeStr = formatBytes(space.free)
          const message = estimatedRequired > 0
            ? t('diskSpace.warningMessage', { free: freeStr, required: formatBytes(estimatedRequired) })
            : t('diskSpace.warningMessageGeneric', { free: freeStr })
          const ok = await modal.confirm({
            title: t('diskSpace.warningTitle'),
            message,
            confirmLabel: t('diskSpace.continueAnyway'),
            confirmStyle: 'primary',
          })
          if (!ok) return
        }
      } catch {
        // If the disk check itself fails, proceed.
      }
    }

    // 8. showProgress — emit show-progress for the host's ProgressModal.
    //    The synthetic `restart` id maps to stop → wait → launch so the
    //    user sees one continuous "Restarting ComfyUI" progress view.
    if (mutableAction.showProgress) {
      const rawTitle = (mutableAction.progressTitle || mutableAction.label).replace(
        /\{(\w+)\}/g,
        (_, k: string) => String((mutableAction.data as Record<string, unknown>)?.[k] ?? k),
      )
      const title = `${rawTitle} — ${inst.name}`
      const isRestart = mutableAction.id === 'restart'
      const apiCall = isRestart
        ? async (): Promise<ReturnType<typeof window.api.runAction>> => {
          await window.api.stopComfyUI(inst.id)
          const deadline = Date.now() + 10_000
          while (sessionStore.isRunning(inst.id) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100))
          }
          return window.api.runAction(inst.id, 'launch')
        }
        : (): ReturnType<typeof window.api.runAction> =>
          window.api.runAction(inst.id, mutableAction.id, mutableAction.data)
      emitTelemetryAction('desktop2.action.invoked', telemetryContext)
      opts.onShowProgress({
        installationId: inst.id,
        title,
        apiCall,
        cancellable: !!mutableAction.cancellable,
        returnTo: 'detail',
        triggersInstanceStart: mutableAction.id === 'launch' || isRestart,
        // Synthetic `restart` id (stop → wait → launch) reads as a launch
        // op to the brand caption pipeline, mirroring its
        // triggersInstanceStart flag.
        opKind: isRestart ? 'launch' : progressOpKindForActionId(mutableAction.id),
        actionId: mutableAction.id,
        actionData: mutableAction.data,
      })
      return
    }

    // 9. Inline invoke + result navigation.
    try {
      emitTelemetryAction('desktop2.action.invoked', telemetryContext)
      const result = await window.api.runAction(inst.id, mutableAction.id, mutableAction.data)
      if (result.running) {
        // Backend detected a race — surface the action guard so the
        // user can stop ComfyUI and retry.
        await actionGuard.checkBeforeAction(inst.id, mutableAction.label)
        return
      }
      const resultValue = result.cancelled ? 'cancelled' : (result.ok === false ? 'failed' : 'ok')
      emitTelemetryAction('desktop2.action.result', { result: resultValue, ...telemetryContext })
      if (result.navigate === 'list') {
        opts.onClose?.()
        opts.onNavigateList?.()
      } else if (result.navigate === 'detail') {
        await reload()
      } else if (result.message) {
        await modal.alert({ title: mutableAction.label, message: result.message })
      } else {
        await reload()
      }
    } catch (err: unknown) {
      emitTelemetryAction('desktop2.action.result', {
        result: 'failed',
        error_bucket: toErrorBucket(err),
        ...telemetryContext,
      })
      await modal.alert({
        title: mutableAction.label,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function sectionsForTab(tab: 'settings' | 'status' | 'update' | 'snapshots'): ComputedRef<DetailSection[]> {
    // `pinBottom` sections live in the drawer footer, not the tab body —
    // mirror DetailModal.vue's split (`mainSections` vs `bottomSection`).
    return computed(() => sections.value.filter((s) => s.tab === tab && !s.pinBottom))
  }

  const pinBottomSection = computed<DetailSection | null>(
    () => sections.value.find((s) => s.pinBottom) ?? null,
  )

  // Launch→Restart synthetic swap, mirrored from DetailModal.vue's
  // `bottomActions`. Source action definitions stay single-purpose
  // (`launch`); `runAction` picks the synthetic `'restart'` id up and
  // routes through stopComfyUI → wait → launch.
  const pinBottomActions = computed<ActionDef[]>(() => {
    const acts = pinBottomSection.value?.actions ?? []
    const inst = toValue(opts.installation)
    if (!inst) return acts
    if (!sessionStore.isRunning(inst.id)) return acts
    return acts.map((a) => {
      if (a.id !== 'launch') return a
      return {
        ...a,
        id: 'restart',
        label: t('actions.restart'),
        style: 'accent',
        progressTitle: t('actions.restartProgressTitle'),
        confirm: {
          title: t('actions.restartConfirmTitle'),
          message: t('actions.restartConfirmMessage'),
          confirmLabel: t('actions.restartConfirm'),
        },
      }
    })
  })

  const diskUsageItem = computed<DetailItem | null>(() => {
    const ds = diskSpace.value
    if (!ds) return null
    // `get-disk-space` returns total + free for the volume — used =
    // total − free. Same arithmetic the legacy DetailModal uses.
    const used = Math.max(0, ds.total - ds.free)
    return {
      label: `${t('comfyUISettings.diskUsage', 'Disk Usage')}: ${formatBytes(used)}`,
    }
  })

  watch(
    () => toValue(opts.installation)?.id ?? null,
    () => {
      void reload()
    },
    { immediate: true },
  )

  return {
    sections,
    diskSpace,
    loading,
    error,
    reload,
    refreshSection,
    updateField,
    runAction,
    sectionsForTab,
    diskUsageItem,
    pinBottomSection,
    pinBottomActions,
  }
}
