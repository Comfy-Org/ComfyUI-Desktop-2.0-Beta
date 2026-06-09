<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../../composables/useModal'
import GlobalSettingsMicroSection from './GlobalSettingsMicroSection.vue'
import ModelsDirList from './ModelsDirList.vue'
import StorageDirRow from '../../views/comfyUISettings/StorageDirRow.vue'
import type { DetailField } from '../../types/ipc'

// Shared global-storage UI rendered identically by the Global Settings
// popup and StoragePane.vue so the two can't drift. Writes persist
// immediately (no save step); `touched` is emitted on any mutation.

interface ModelsDir {
  path: string
  isPrimary: boolean
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
}

const props = defineProps<Props>()

const emit = defineEmits<{
  touched: []
}>()

const { t } = useI18n()
const modal = useModal()

const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge })
  .__comfyTitlePopup

/** Shared input/output fields from the snapshot, keyed by id so they render as
 *  the same readonly path rows used in the per-instance Storage tab. */
const sharedDirFields = computed<Record<string, DetailField>>(() => {
  const map: Record<string, DetailField> = {}
  for (const f of props.snapshot.sharedDirectoriesFields as unknown as DetailField[]) {
    map[f.id] = f
  }
  return map
})
const sharedInputField = computed(() => sharedDirFields.value.inputDir)
const sharedOutputField = computed(() => sharedDirFields.value.outputDir)

function sharedFieldPath(field: DetailField | undefined): string {
  return typeof field?.value === 'string' ? field.value : ''
}

function handleOpenPath(path: string): void {
  if (path) bridge?.globalSettingsOpenPath(path)
}

async function browseSharedDir(field: DetailField | undefined): Promise<void> {
  if (!field) return
  const picked = await bridge?.globalSettingsBrowseFolder(sharedFieldPath(field) || undefined)
  if (!picked || picked === field.value) return
  emit('touched')
  await bridge?.globalSettingsUpdateField(field.id, picked)
}

function handleBrowseSharedInput(): void {
  void browseSharedDir(sharedInputField.value)
}
function handleBrowseSharedOutput(): void {
  void browseSharedDir(sharedOutputField.value)
}

function handleOpenModelsDir(index: number): void {
  const dir = props.snapshot.modelsDirs[index]
  if (dir) bridge?.globalSettingsOpenPath(dir.path)
}

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

async function handleChangeModelsDir(index: number): Promise<void> {
  const current = props.snapshot.modelsDirs[index]?.path
  const picked = await bridge?.globalSettingsBrowseFolder(current)
  if (!picked || picked === current) return
  emit('touched')
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs[index] = picked
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

</script>

<template>
  <GlobalSettingsMicroSection
    :title="t('settings.models', 'Shared Models')"
    :tooltip="t('tooltips.sharedModels')"
  >
    <ModelsDirList
      :dirs="snapshot.modelsDirs"
      @change="handleChangeModelsDir"
      @remove="handleRemoveModelsDir"
      @make-primary="handleMakePrimary"
      @open="handleOpenModelsDir"
      @add="handleAddModelsDir"
    />
  </GlobalSettingsMicroSection>

  <GlobalSettingsMicroSection :title="t('settings.sharedDirectories', 'Shared Directories')">
    <StorageDirRow
      v-if="sharedInputField"
      :label="sharedInputField.label || t('media.inputDir', 'Input Directory')"
      :path="sharedFieldPath(sharedInputField)"
      @open="handleOpenPath(sharedFieldPath(sharedInputField))"
      @browse="handleBrowseSharedInput"
    />
    <StorageDirRow
      v-if="sharedOutputField"
      :label="sharedOutputField.label || t('media.outputDir', 'Output Directory')"
      :path="sharedFieldPath(sharedOutputField)"
      @open="handleOpenPath(sharedFieldPath(sharedOutputField))"
      @browse="handleBrowseSharedOutput"
    />
  </GlobalSettingsMicroSection>
</template>
