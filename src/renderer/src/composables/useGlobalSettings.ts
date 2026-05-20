import { computed, onMounted, onUnmounted, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useComfyUISettings } from './useComfyUISettings'
import type {
  ActionDef,
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
  DetailSection,
  Installation,
  SettingsField,
  SettingsSection,
  ShowProgressOpts,
} from '../types/ipc'

/**
 * Backing state + IPC plumbing for the brand-redesigned Global Settings
 * panel (`GlobalSettingsPanel.vue`). Extracted into a composable so the
 * component stays UI-only — same convention as `useComfyUISettings`.
 *
 * Mix of three concerns:
 *  - Truly-global settings (Language / Theme / Cache / Advanced / Shared
 *    Directories) sourced from `getSettingsSections()` + `getMediaSections()`
 *    and written via `setSetting(key, value)`.
 *  - Truly-global Models Directory list — `getModelsSections()` +
 *    `setSetting('modelsDirs', [...])`.
 *  - Launcher updater state (Installed/Latest/Status) + install-scoped
 *    Update Channel + Copy & Update actions, the latter two delegated to
 *    `useComfyUISettings` so the existing 9-stage `runAction` dispatcher
 *    (confirm chains, disk checks, progress) is reused as-is.
 */

const LAST_CHECKED_KEY = 'globalSettings.lastCheckedAt'

const SETTINGS_TYPE_TO_DETAIL_EDIT_TYPE: Record<SettingsField['type'], DetailField['editType']> = {
  text: 'text',
  number: 'number',
  path: 'path',
  select: 'select',
  boolean: 'boolean',
  pathList: undefined, // unused in global settings (only Models, handled bespoke)
}

function toDetailField(f: SettingsField): DetailField {
  return {
    id: f.id,
    label: f.label,
    value: (f.value as DetailField['value']) ?? null,
    editable: !f.readonly,
    editType: SETTINGS_TYPE_TO_DETAIL_EDIT_TYPE[f.type],
    options: f.options?.map((o) => ({ value: o.value, label: o.label })),
    tooltip: f.tooltip,
    placeholder: f.placeholder,
    min: f.min,
    max: f.max,
  }
}

export interface UseGlobalSettingsOpts {
  /** The host window's active installation, if any. Drives install-
   *  scoped controls (Update Channel + Copy & Update). Install-less
   *  hosts pass `null` — those controls stay hidden. */
  installation: MaybeRefOrGetter<Installation | null>
  /** Fires when an install-scoped action requests a ProgressModal —
   *  forwarded to PanelApp's overlay slot. */
  onShowProgress: (opts: ShowProgressOpts) => void
  /** Fires when an install-scoped action's `result.navigate === 'list'`
   *  (delete / untrack). The host should tear the comfy window down. */
  onNavigateList?: () => void
  /** Fires alongside `onNavigateList` so the panel can animate dismissal
   *  before the host completes navigation. */
  onClose?: () => void
}

export interface UseGlobalSettingsApi {
  // --- truly-global, field-shaped (rendered via SettingsSectionList) ---
  overviewFields: ComputedRef<DetailField[]>
  cacheFields: ComputedRef<DetailField[]>
  advancedFields: ComputedRef<DetailField[]>
  sharedDirectoriesFields: ComputedRef<DetailField[]>

  // --- truly-global, Models accordion (bespoke pathList renderer) ---
  modelsDirs: Ref<string[]>
  modelsSystemDefault: Ref<string>
  addModelsDir: () => Promise<void>
  browseModelsDir: (index: number) => Promise<void>
  openModelsDir: (path: string) => void
  removeModelsDir: (index: number) => Promise<void>
  makeModelsDirPrimary: (index: number) => Promise<void>

  // --- Updates section: launcher state ---
  updateState: Ref<AppUpdateState>
  updateProgress: Ref<AppUpdateDownloadProgress | null>
  isDownloading: ComputedRef<boolean>
  checking: Ref<boolean>
  lastCheckedAt: Ref<number | null>
  installedVersion: Ref<string>
  platformLabel: ComputedRef<string>
  systemManaged: Ref<boolean>
  handleUpdateNow: () => Promise<void>
  handleCheckForUpdate: () => Promise<void>

  // --- Updates section: install-scoped (Update Channel + Copy & Update) ---
  /** The `channel-cards` field from the active install's Update tab.
   *  Null when the host has no install OR the source emits no
   *  channel-picker payload (e.g. cloud installs). */
  channelPickerField: ComputedRef<DetailField | null>
  /** Dispatch an action coming off `ChannelPicker`'s `@action` emit
   *  (`update`, `copy-update`, `switch-channel`). Routes through
   *  `useComfyUISettings.runAction` so all confirm/disk/progress logic
   *  is reused. */
  runInstallAction: (action: ActionDef) => Promise<void>

  // --- top-level state ---
  loading: Ref<boolean>
  error: Ref<string | null>

  /** Truly-global setting mutation (Language / Theme / Cache etc.). */
  updateField: (field: DetailField, value: unknown) => Promise<void>

  /** Refetch all data sources (settings + media + models + install
   *  detail sections). Subscribed to `settings-changed` broadcast. */
  reload: () => Promise<void>
}

export function useGlobalSettings(opts: UseGlobalSettingsOpts): UseGlobalSettingsApi {
  const { t } = useI18n()
  const modal = useModal()

  // ---- global sections (settings + media + models) ----
  const settingsSections = ref<SettingsSection[]>([])
  const mediaSections = ref<SettingsSection[]>([])
  const modelsDirs = ref<string[]>([])
  const modelsSystemDefault = ref<string>('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function loadGlobal(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const [settings, media, models] = await Promise.all([
        window.api.getSettingsSections(),
        window.api.getMediaSections(),
        window.api.getModelsSections(),
      ])
      settingsSections.value = settings
      mediaSections.value = media
      modelsDirs.value = (models.sections[0]?.fields[0]?.value as string[] | undefined) ?? []
      modelsSystemDefault.value = models.systemDefault
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // Section mapping by title — main owns ordering; we look up by the
  // localised title since main interleaves source-supplied sections
  // mid-list. Falls back to the legacy positional order if a title
  // lookup misses so we degrade gracefully on locale-key changes.
  function sectionByTitle(titleKey: string, fallbackIndex: number): SettingsSection | undefined {
    const localised = t(titleKey)
    const found = settingsSections.value.find((s) => s.title === localised)
    if (found) return found
    return settingsSections.value[fallbackIndex]
  }

  const overviewFields = computed<DetailField[]>(() => {
    const general = sectionByTitle('settings.general', 0)?.fields ?? []
    const telemetry = sectionByTitle('settings.telemetry', 1)?.fields ?? []
    return [...general, ...telemetry].map(toDetailField)
  })

  const cacheFields = computed<DetailField[]>(() =>
    (sectionByTitle('settings.cache', 2)?.fields ?? []).map(toDetailField),
  )

  const advancedFields = computed<DetailField[]>(() =>
    (sectionByTitle('settings.advanced', 3)?.fields ?? []).map(toDetailField),
  )

  const sharedDirectoriesFields = computed<DetailField[]>(() =>
    (mediaSections.value[0]?.fields ?? []).map(toDetailField),
  )

  async function updateField(field: DetailField, value: unknown): Promise<void> {
    await window.api.setSetting(field.id, value)
    // Main broadcasts `settings-changed` after every write, so the
    // subscription below will trigger a reload automatically. We don't
    // await reload() here — let the broadcast drive it.
  }

  // ---- Models handlers (lifted 1:1 from DirectoriesView.vue) ----
  async function persistModelsDirs(): Promise<void> {
    await window.api.setSetting('modelsDirs', [...modelsDirs.value])
  }

  async function addModelsDir(): Promise<void> {
    const dir = await window.api.browseFolder()
    if (!dir) return
    modelsDirs.value.push(dir)
    await persistModelsDirs()
  }

  async function browseModelsDir(index: number): Promise<void> {
    const dir = await window.api.browseFolder(modelsDirs.value[index])
    if (!dir) return
    modelsDirs.value[index] = dir
    await persistModelsDirs()
  }

  function openModelsDir(path: string): void {
    window.api.openPath(path)
  }

  async function removeModelsDir(index: number): Promise<void> {
    modelsDirs.value.splice(index, 1)
    await persistModelsDirs()
  }

  async function makeModelsDirPrimary(index: number): Promise<void> {
    const path = modelsDirs.value[index]
    if (!path) return
    modelsDirs.value.splice(index, 1)
    modelsDirs.value.unshift(path)
    await persistModelsDirs()
  }

  // ---- Launcher updater state ----
  const updateState = ref<AppUpdateState>({ kind: null, version: null, autoUpdate: true })
  const updateProgress = ref<AppUpdateDownloadProgress | null>(null)
  const checking = ref(false)
  const downloadStarting = ref(false)
  const installedVersion = ref<string>('')
  const systemManaged = ref(false)
  const lastCheckedAt = ref<number | null>(loadLastCheckedAt())

  function loadLastCheckedAt(): number | null {
    try {
      const raw = window.localStorage.getItem(LAST_CHECKED_KEY)
      if (!raw) return null
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    } catch {
      return null
    }
  }

  function persistLastCheckedAt(value: number): void {
    try {
      window.localStorage.setItem(LAST_CHECKED_KEY, String(value))
    } catch {
      // localStorage unavailable — silently drop, the timestamp is a
      // nice-to-have, not load-bearing.
    }
  }

  const isDownloading = computed(
    () => downloadStarting.value || updateState.value.kind === 'downloading',
  )

  // `process` doesn't exist in the renderer; pull platform from preload
  // (synchronously published by `api.ts` as `window.api.platform`).
  // `arch` isn't exposed renderer-side — legacy "About" built the full
  // string main-side. Just show platform for now; main-side enrichment
  // can land if/when the user wants arch back.
  const platformLabel = computed(() => {
    const p = window.api.platform
    if (p === 'darwin') return 'macOS'
    if (p === 'win32') return 'Windows'
    if (p === 'linux') return 'Linux'
    return p
  })

  function onUpdateStateChanged(next: AppUpdateState): void {
    // Mirrors AppUpdateAction.vue: once the cached state moves out of
    // available/downloading, clear local in-flight flag + progress so the
    // CTA re-reads fresh.
    if (next.kind !== 'available' && next.kind !== 'downloading') {
      downloadStarting.value = false
      updateProgress.value = null
    }
    updateState.value = next
  }

  function onUpdateDownloadProgress(next: AppUpdateDownloadProgress): void {
    updateProgress.value = next
  }

  function onUserActionFailed(): void {
    downloadStarting.value = false
    updateProgress.value = null
  }

  async function handleUpdateNow(): Promise<void> {
    const kind = updateState.value.kind
    if (kind === 'ready') {
      await window.api.installUpdate()
      return
    }
    if (kind === 'available') {
      downloadStarting.value = true
      updateProgress.value = null
      try {
        await window.api.downloadUpdate()
      } catch {
        downloadStarting.value = false
        updateProgress.value = null
      }
      return
    }
    // null state → treat Update Now as Check For Update.
    await handleCheckForUpdate()
  }

  async function handleCheckForUpdate(): Promise<void> {
    checking.value = true
    try {
      const result = await window.api.checkForUpdate()
      lastCheckedAt.value = Date.now()
      persistLastCheckedAt(lastCheckedAt.value)
      if (result.error) {
        await modal.alert({
          title: t('update.updateError'),
          message: result.error,
        })
        return
      }
      if (!result.available && updateState.value.kind === null) {
        const message = systemManaged.value ? t('update.debUpToDate') : t('update.upToDate')
        await modal.alert({ title: t('update.updateCheck'), message })
      }
    } finally {
      checking.value = false
    }
  }

  // ---- Install-scoped slice (Update Channel + Copy & Update) ----
  // Delegate to useComfyUISettings so the runAction 9-stage dispatcher
  // (confirm chains / disk checks / progress modal) is reused as-is.
  const comfy = useComfyUISettings({
    installation: opts.installation,
    onShowProgress: opts.onShowProgress,
    onNavigateList: opts.onNavigateList,
    onClose: opts.onClose,
  })

  const channelPickerField = computed<DetailField | null>(() => {
    const updateSections: DetailSection[] = comfy.sectionsForTab('update').value
    for (const sec of updateSections) {
      const f = sec.fields?.find((ff) => ff.editType === 'channel-cards')
      if (f) return f
    }
    return null
  })

  async function runInstallAction(action: ActionDef): Promise<void> {
    await comfy.runAction(action)
  }

  // ---- Subscriptions + lifecycle ----
  let unsubSettings: (() => void) | null = null
  let unsubUpdateState: (() => void) | null = null
  let unsubProgress: (() => void) | null = null
  let unsubFailed: (() => void) | null = null

  async function reload(): Promise<void> {
    await Promise.all([
      loadGlobal(),
      // The install-scoped slice reloads on installation watcher inside
      // useComfyUISettings; we trigger an explicit reload too so a
      // settings-changed broadcast (e.g. channel switch) re-fetches.
      comfy.reload(),
    ])
  }

  onMounted(async () => {
    try {
      installedVersion.value = await window.api.getAppVersion()
    } catch {
      installedVersion.value = ''
    }
    try {
      const caps = await window.api.getUpdateCapabilities()
      systemManaged.value = caps.systemManaged
    } catch {
      systemManaged.value = false
    }
    try {
      updateState.value = await window.api.getAppUpdateState()
    } catch {
      // leave default null state
    }

    await loadGlobal()

    unsubSettings = window.api.onSettingsChanged(() => {
      void loadGlobal()
    })
    unsubUpdateState = window.api.onAppUpdateStateChanged(onUpdateStateChanged)
    unsubProgress = window.api.onAppUpdateDownloadProgress(onUpdateDownloadProgress)
    unsubFailed = window.api.onAppUpdateUserActionFailed(onUserActionFailed)
  })

  onUnmounted(() => {
    unsubSettings?.()
    unsubUpdateState?.()
    unsubProgress?.()
    unsubFailed?.()
  })

  // When the active installation changes (rare, but happens on chooser
  // → install-backed swap), the channel-picker field needs to refetch.
  // useComfyUISettings already watches `installation` internally and
  // reloads, so we only need to re-derive — no extra work here.
  watch(
    () => toValue(opts.installation)?.id ?? null,
    () => {
      // intentionally empty — comfy composable handles refetch
    },
  )

  return {
    overviewFields,
    cacheFields,
    advancedFields,
    sharedDirectoriesFields,

    modelsDirs,
    modelsSystemDefault,
    addModelsDir,
    browseModelsDir,
    openModelsDir,
    removeModelsDir,
    makeModelsDirPrimary,

    updateState,
    updateProgress,
    isDownloading,
    checking,
    lastCheckedAt,
    installedVersion,
    platformLabel,
    systemManaged,
    handleUpdateNow,
    handleCheckForUpdate,

    channelPickerField,
    runInstallAction,

    loading,
    error,
    updateField,
    reload,
  }
}
