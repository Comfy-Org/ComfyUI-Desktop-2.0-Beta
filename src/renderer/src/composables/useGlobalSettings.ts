import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { emitTelemetryAction } from '../lib/telemetry'
import type {
  ActionDef,
  DetailField,
  DetailItem,
  DetailSection,
  DiskSpaceInfo,
  Installation,
  ShowProgressOpts,
} from '../types/ipc'

/**
 * Backing state + IPC plumbing for the brand-redesigned Settings drawer
 * (`GlobalSettingsPanel.vue`). Extracted into a composable so the
 * component stays UI-only — same convention as the title-bar
 * `useTitleBarMenus` / `usePanelOverlays` split.
 *
 * All four tabs source from `getDetailSections()` — the same payload
 * `DetailModal` reads — and writes through `update-installation` /
 * `runAction`. Disk Usage is a separate `get-disk-space` call merged
 * into the Status tab as a synthetic row.
 *
 * Action handling is a trimmed mirror of `DetailModal.runAction`:
 *   - `action.confirm` → useModal.confirm
 *   - `action.showProgress` → invokes the caller's `onShowProgress`
 *     (so PanelApp drives the existing ProgressModal flow)
 *   - else → invoke `window.api.runAction` inline + reload sections
 * Prompt / fieldSelects / select dialog flows are not ported yet; see
 * TODO(global-settings-v2) inside `runAction`.
 */

export interface UseGlobalSettingsOpts {
  /** Accept any reactive source — `Ref`, `ComputedRef`, or getter — so
   *  callers can pass `toRef(props, 'installation')` directly. */
  installation: MaybeRefOrGetter<Installation | null>
  /** Fires when an action requests a ProgressModal — the host
   *  (`PanelApp.vue`) already owns the modal and consumes this shape
   *  via `usePanelOverlays.handleShowProgress`. */
  onShowProgress: (opts: ShowProgressOpts) => void
}

export interface UseGlobalSettingsApi {
  sections: Ref<DetailSection[]>
  diskSpace: Ref<DiskSpaceInfo | null>
  loading: Ref<boolean>
  error: Ref<string | null>

  /** Refresh sections + disk usage for the current installation. */
  reload: () => Promise<void>

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

export function useGlobalSettings(opts: UseGlobalSettingsOpts): UseGlobalSettingsApi {
  const { t } = useI18n()
  const modal = useModal()

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

  async function updateField(field: DetailField, value: unknown): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) return
    await window.api.updateInstallation(inst.id, { [field.id]: value })
    emitTelemetryAction('desktop2.settings.changed', {
      setting_key: field.id,
      value_kind: field.editType || 'text',
      bool_value: typeof value === 'boolean' ? value : undefined,
    })
    await reload()
  }

  async function runAction(action: ActionDef): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) return

    // TODO(global-settings-v2): prompt / fieldSelects / select dialogs
    // aren't ported yet — see DetailModal.vue `runAction` for the full
    // shape. Actions with those payloads fall through to a plain invoke.
    if (action.confirm) {
      const ok = await modal.confirm({
        title: action.confirm.title || action.label,
        message: action.confirm.message || '',
        confirmLabel: action.confirm.confirmLabel || action.label,
        confirmStyle: action.style === 'danger' ? 'danger' : 'primary',
      })
      if (!ok) return
    }

    if (action.showProgress) {
      const rawTitle = (action.progressTitle || action.label).replace(
        /\{(\w+)\}/g,
        (_, k: string) => String((action.data as Record<string, unknown>)?.[k] ?? k),
      )
      opts.onShowProgress({
        installationId: inst.id,
        title: `${rawTitle} — ${inst.name}`,
        apiCall: () => window.api.runAction(inst.id, action.id, action.data),
        cancellable: !!action.cancellable,
        returnTo: 'detail',
        triggersInstanceStart: action.id === 'launch' || action.id === 'restart',
      })
      return
    }

    emitTelemetryAction('desktop2.action.invoked', { action_id: action.id })
    const result = await window.api.runAction(inst.id, action.id, action.data)
    if (result.message) {
      await modal.alert({ title: action.label, message: result.message })
    }
    await reload()
  }

  function sectionsForTab(tab: 'settings' | 'status' | 'update' | 'snapshots'): ComputedRef<DetailSection[]> {
    // `pinBottom` sections live in the drawer footer, not the tab body —
    // mirror DetailModal.vue's split (`mainSections` vs `bottomSection`).
    return computed(() => sections.value.filter((s) => s.tab === tab && !s.pinBottom))
  }

  const pinBottomSection = computed<DetailSection | null>(
    () => sections.value.find((s) => s.pinBottom) ?? null,
  )

  const diskUsageItem = computed<DetailItem | null>(() => {
    const ds = diskSpace.value
    if (!ds) return null
    // `get-disk-space` returns total + free for the volume — used =
    // total − free. Same arithmetic the legacy DetailModal uses.
    const used = Math.max(0, ds.total - ds.free)
    return {
      label: `${t('globalSettings.diskUsage', 'Disk Usage')}: ${formatBytes(used)}`,
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
    updateField,
    runAction,
    sectionsForTab,
    diskUsageItem,
    pinBottomSection,
  }
}
