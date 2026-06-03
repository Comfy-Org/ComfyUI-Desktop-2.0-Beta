<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../../composables/useModal'
import GlobalSettingsMicroSection from './GlobalSettingsMicroSection.vue'
import ModelsDirList from './ModelsDirList.vue'
import SettingsSectionList from '../../views/comfyUISettings/SettingsSectionList.vue'
import type { DetailField, DetailSection } from '../../types/ipc'

/**
 * Shared "global storage" UI — the Shared Models directory list plus
 * the Shared Directories field section. Rendered identically by the
 * Global Settings popup's Storage tab and by the per-instance Storage
 * pane (`StoragePane.vue`) so the two surfaces can't drift.
 *
 * All writes are persisted immediately through the existing
 * `__comfyTitlePopup.globalSettings*` bridge — there is no save step.
 * `touched` is emitted on any mutating action so hosts that care
 * (StoragePane drives a restart-warning bar) can react; hosts that
 * don't care (Global Settings popup) just ignore it.
 */

interface ModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

export interface GlobalStorageSnapshot {
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: ModelsDir[]
  modelsSystemDefault: string
}

interface GlobalSettingsBridge {
  globalSettingsUpdateField(
    fieldId: string,
    value: unknown
  ): Promise<{ ok: boolean; message?: string }>
  globalSettingsBrowseFolder(defaultPath?: string): Promise<string | null>
  globalSettingsOpenPath(path: string): void
  globalSettingsSetModelsDirs(dirs: string[]): Promise<{ ok: boolean }>
}

interface Props {
  snapshot: GlobalStorageSnapshot
  /** Forwarded to the inner Shared Directories `SettingsSectionList`
   *  so install-aware fields (today: none — these are all global
   *  fields, but the prop is wired through for parity with the
   *  per-install renderer in StoragePane). */
  installationId?: string
  pendingRestartFieldIds?: Set<string>
  fieldErrorMessages?: Map<string, string>
  runningActionIds?: Set<string>
}

const props = withDefaults(defineProps<Props>(), {
  installationId: undefined,
  pendingRestartFieldIds: () => new Set<string>(),
  fieldErrorMessages: () => new Map<string, string>(),
  runningActionIds: () => new Set<string>(),
})

const emit = defineEmits<{
  touched: []
}>()

const { t } = useI18n()
const modal = useModal()

const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge })
  .__comfyTitlePopup

const sharedDirsSections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.sharedDirectoriesFields as unknown as DetailField[] },
])

async function handleAddModelsDir(): Promise<void> {
  const picked = await bridge?.globalSettingsBrowseFolder()
  if (!picked) return
  emit('touched')
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs.push(picked)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleRemoveModelsDir(index: number): Promise<void> {
  const dir = props.snapshot.modelsDirs[index]
  if (!dir) return
  const ok = await modal.confirm({
    title: t('models.removeDirTitle', 'Remove shared models directory?'),
    message: t(
      'models.removeDirConfirm',
      "This won't delete any files. You can re-add the directory later from this list."
    ),
    confirmLabel: t('models.removeDir', 'Remove'),
    confirmStyle: 'danger',
  })
  if (!ok) return
  emit('touched')
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs.splice(index, 1)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleMakePrimary(index: number): Promise<void> {
  emit('touched')
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  const moved = dirs.splice(index, 1)[0]
  if (typeof moved !== 'string') return
  dirs.unshift(moved)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

function handleOpenModelsDir(path: string): void {
  bridge?.globalSettingsOpenPath(path)
}

async function handleUpdateSharedDirField(field: DetailField, value: unknown): Promise<void> {
  emit('touched')
  await bridge?.globalSettingsUpdateField(field.id, value)
}
</script>

<template>
  <GlobalSettingsMicroSection
    :title="t('settings.models', 'Shared Models')"
    :tooltip="t('tooltips.sharedModels')"
  >
    <ModelsDirList
      :dirs="snapshot.modelsDirs"
      @open="handleOpenModelsDir"
      @remove="handleRemoveModelsDir"
      @make-primary="handleMakePrimary"
      @add="handleAddModelsDir"
    />
  </GlobalSettingsMicroSection>

  <GlobalSettingsMicroSection :title="t('settings.sharedDirectories', 'Shared Directories')">
    <SettingsSectionList
      :sections="sharedDirsSections"
      :installation-id="installationId"
      :running-action-ids="runningActionIds"
      :pending-restart-field-ids="pendingRestartFieldIds"
      :field-error-messages="fieldErrorMessages"
      @update-field="handleUpdateSharedDirField"
    />
  </GlobalSettingsMicroSection>
</template>
