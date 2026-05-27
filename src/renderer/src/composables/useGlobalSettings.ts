import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import type {
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
  SettingsField,
  SettingsSection,
} from '../types/ipc'

/**
 * Backing state + IPC plumbing for a future Global Settings panel host.
 * The title-bar popup uses snapshot props instead; this composable mirrors
 * the same desktop-only bucket shape for reuse.
 */

const LAST_CHECKED_KEY = 'globalSettings.lastCheckedAt'

const SETTINGS_TYPE_TO_DETAIL_EDIT_TYPE: Record<SettingsField['type'], DetailField['editType']> = {
  text: 'text',
  number: 'number',
  path: 'path',
  select: 'select',
  boolean: 'boolean',
  pathList: undefined,
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
  onClose?: () => void
}

export interface UseGlobalSettingsApi {
  generalFields: ComputedRef<DetailField[]>
  telemetryFields: ComputedRef<DetailField[]>
  desktopUpdateFields: ComputedRef<DetailField[]>
  cacheFields: ComputedRef<DetailField[]>
  advancedFields: ComputedRef<DetailField[]>
  sharedDirectoriesFields: ComputedRef<DetailField[]>

  modelsDirs: Ref<string[]>
  modelsSystemDefault: Ref<string>
  addModelsDir: () => Promise<void>
  browseModelsDir: (index: number) => Promise<void>
  openModelsDir: (path: string) => void
  removeModelsDir: (index: number) => Promise<void>
  makeModelsDirPrimary: (index: number) => Promise<void>

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

  loading: Ref<boolean>
  error: Ref<string | null>
  updateField: (field: DetailField, value: unknown) => Promise<void>
  reload: () => Promise<void>
}

export function useGlobalSettings(_opts: UseGlobalSettingsOpts = {}): UseGlobalSettingsApi {
  const { t } = useI18n()
  const modal = useModal()

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

  function sectionByTitle(titleKey: string, fallbackIndex: number): SettingsSection | undefined {
    const localised = t(titleKey)
    const found = settingsSections.value.find((s) => s.title === localised)
    if (found) return found
    return settingsSections.value[fallbackIndex]
  }

  const generalFields = computed<DetailField[]>(() => {
    const fields = sectionByTitle('settings.general', 0)?.fields ?? []
    return fields.filter((f) => f.id !== 'autoInstallUpdates').map(toDetailField)
  })

  const desktopUpdateFields = computed<DetailField[]>(() => {
    const fields = sectionByTitle('settings.general', 0)?.fields ?? []
    return fields.filter((f) => f.id === 'autoInstallUpdates').map(toDetailField)
  })

  const telemetryFields = computed<DetailField[]>(() =>
    (sectionByTitle('settings.telemetry', 1)?.fields ?? []).map(toDetailField),
  )

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
  }

  async function persistModelsDirs(): Promise<void> {
    await window.api.setSetting('modelsDirs', [...modelsDirs.value])
  }

  async function addModelsDir(): Promise<void> {
    const picked = await window.api.browseFolder()
    if (!picked) return
    modelsDirs.value.push(picked)
    await persistModelsDirs()
  }

  async function browseModelsDir(index: number): Promise<void> {
    const current = modelsDirs.value[index]
    const picked = await window.api.browseFolder(current)
    if (!picked) return
    modelsDirs.value[index] = picked
    await persistModelsDirs()
  }

  function openModelsDir(path: string): void {
    void window.api.openPath(path)
  }

  async function removeModelsDir(index: number): Promise<void> {
    modelsDirs.value.splice(index, 1)
    await persistModelsDirs()
  }

  async function makeModelsDirPrimary(index: number): Promise<void> {
    const moved = modelsDirs.value.splice(index, 1)[0]
    if (typeof moved !== 'string') return
    modelsDirs.value.unshift(moved)
    await persistModelsDirs()
  }

  const updateState = ref<AppUpdateState>({ kind: null, version: null, autoUpdate: true })
  const updateProgress = ref<AppUpdateDownloadProgress | null>(null)
  const downloadStarting = ref(false)
  const checking = ref(false)
  const lastCheckedAt = ref<number | null>(null)
  const installedVersion = ref('')
  const systemManaged = ref(false)

  function persistLastCheckedAt(value: number): void {
    try {
      window.localStorage.setItem(LAST_CHECKED_KEY, String(value))
    } catch {
      /* noop */
    }
  }

  const isDownloading = computed(
    () => downloadStarting.value || updateState.value.kind === 'downloading',
  )

  const platformLabel = computed(() => {
    const p = window.api.platform
    if (p === 'darwin') return 'macOS'
    if (p === 'win32') return 'Windows'
    if (p === 'linux') return 'Linux'
    return p
  })

  function onUpdateStateChanged(next: AppUpdateState): void {
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

  let unsubSettings: (() => void) | null = null
  let unsubUpdateState: (() => void) | null = null
  let unsubProgress: (() => void) | null = null
  let unsubFailed: (() => void) | null = null

  async function reload(): Promise<void> {
    await loadGlobal()
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
      /* leave default null state */
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

  return {
    generalFields,
    telemetryFields,
    desktopUpdateFields,
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

    loading,
    error,
    updateField,
    reload,
  }
}
