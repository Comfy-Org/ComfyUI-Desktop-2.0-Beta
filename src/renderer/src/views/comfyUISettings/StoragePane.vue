<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Info } from 'lucide-vue-next'
import { useModal } from '../../composables/useModal'
import GlobalSettingsMicroSection from '../../comfyTitlePopup/globalSettings/GlobalSettingsMicroSection.vue'
import ModelsDirList from '../../comfyTitlePopup/globalSettings/ModelsDirList.vue'
import SettingsSectionList from './SettingsSectionList.vue'
import type { DetailField, DetailSection, Installation } from '../../types/ipc'

/** Storage tab pane for the instance-picker settings. Composes the global
 *  shared-models UI (via the popup's `__comfyTitlePopup.globalSettings*`
 *  bridge) with the per-install storage section from `props.sections`. */

interface ModelsDir {
  path: string
  isPrimary: boolean
}

export interface StorageSnapshot {
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
  installation: Installation | null
  /** Global snapshot fields, passed as a prop so the picker doesn't subscribe twice. */
  snapshot: StorageSnapshot
  /** Per-install storage sections; git installs omit them entirely. */
  sections: DetailSection[]
  pendingRestartFieldIds: Set<string>
  fieldErrorMessages: Map<string, string>
  runningActionIds: Set<string>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-field': [field: DetailField, value: unknown]
}>()

const { t } = useI18n()
const modal = useModal()

const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge })
  .__comfyTitlePopup

/** Whether any global field was touched this session. Writes persist
 *  immediately; this is just the signal driving the top-of-tab warning swap. */
const globalTouched = ref(false)

watch(
  () => props.installation?.id ?? null,
  () => {
    globalTouched.value = false
  }
)

/** Edits to these per-install fields also trigger the restart prompt. */
const PER_INSTALL_STORAGE_FIELD_IDS = ['useSharedModels', 'useSharedInputOutput', 'inputDir', 'outputDir']

const showRestartWarning = computed(() => {
  if (globalTouched.value) return true
  return PER_INSTALL_STORAGE_FIELD_IDS.some((id) => props.pendingRestartFieldIds.has(id))
})

// Computed (not inlined `:is`) so `<script setup>` counts the icon imports as used.
const noteIcon = computed(() => (showRestartWarning.value ? AlertTriangle : Info))

const sharedDirsSections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.sharedDirectoriesFields as unknown as DetailField[] },
])

const perInstallFields = computed<DetailField[]>(() =>
  props.sections.flatMap((s) => s.fields ?? [])
)

function findField(id: string): DetailField | undefined {
  return perInstallFields.value.find((f) => f.id === id)
}

/** `useSharedModels` toggle (defaults on). When off, the global Shared
 *  Models list is hidden and replaced with an inline warning. */
const useSharedModelsEnabled = computed<boolean>(() => {
  const f = findField('useSharedModels')
  return f ? f.value !== false : true
})

/** `useSharedInputOutput` toggle (defaults on). When off, the global
 *  Shared Directories list is hidden and per-install pickers show instead. */
const useSharedInputOutputEnabled = computed<boolean>(() => {
  const f = findField('useSharedInputOutput')
  return f ? f.value !== false : true
})

/** Per-install sections, with `inputDir` / `outputDir` filtered out when
 *  shared input/output is on (they're meaningless in that mode). */
const perInstallSections = computed<DetailSection[]>(() => {
  if (useSharedInputOutputEnabled.value) {
    return props.sections.map((s) => ({
      ...s,
      fields: (s.fields ?? []).filter((f) => f.id !== 'inputDir' && f.id !== 'outputDir'),
    }))
  }
  return props.sections
})

async function handleAddModelsDir(): Promise<void> {
  const picked = await bridge?.globalSettingsBrowseFolder()
  if (!picked) return
  globalTouched.value = true
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
  globalTouched.value = true
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs.splice(index, 1)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleMakePrimary(index: number): Promise<void> {
  globalTouched.value = true
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
  globalTouched.value = true
  await bridge?.globalSettingsUpdateField(field.id, value)
}

function handleUpdatePerInstallField(field: DetailField, value: unknown): void {
  emit('update-field', field, value)
}
</script>

<template>
  <div class="storage-pane">
    <div class="storage-note" :class="{ 'is-warning': showRestartWarning }" role="status">
      <component
        :is="noteIcon"
        :size="14"
        class="storage-note-icon"
        aria-hidden="true"
      />
      <p class="storage-note-text">
        <template v-if="showRestartWarning">
          {{
            t(
              'comfyUISettings.storageRestartNote',
              'Restart the application (or close and reopen) for these changes to take effect.'
            )
          }}
        </template>
        <template v-else>
          {{
            t(
              'comfyUISettings.storageGlobalNote',
              'Changes here apply to all of your ComfyUI instances.'
            )
          }}
        </template>
      </p>
    </div>

    <!-- Per-install toggles + path pickers above the global lists so the
         opt-in reads first. Hidden for git installs (no storage section). -->
    <SettingsSectionList
      v-if="perInstallSections.length > 0"
      :sections="perInstallSections"
      :installation-id="installation?.id"
      :running-action-ids="runningActionIds"
      :pending-restart-field-ids="pendingRestartFieldIds"
      :field-error-messages="fieldErrorMessages"
      @update-field="handleUpdatePerInstallField"
    />

    <!-- Inline warning when shared models is OFF, before a workflow
         fails to find a model. -->
    <div
      v-if="findField('useSharedModels') && !useSharedModelsEnabled"
      class="storage-pane-warning"
      role="alert"
    >
      <AlertTriangle :size="14" class="storage-pane-warning-icon" aria-hidden="true" />
      <p class="storage-pane-warning-text">
        {{
          t(
            'comfyUISettings.useSharedModelsOffWarning',
            'Shared models is OFF for this install. It can only see models placed under its own folder — your shared library is hidden until you turn this back on.'
          )
        }}
      </p>
    </div>

    <!-- Hidden when this install opts out of shared models. -->
    <GlobalSettingsMicroSection
      v-if="useSharedModelsEnabled"
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

    <!-- Hidden when shared input/output is off; the per-install pickers
         above cover the same ground. -->
    <GlobalSettingsMicroSection
      v-if="useSharedInputOutputEnabled"
      :title="t('settings.sharedDirectories', 'Shared Directories')"
    >
      <SettingsSectionList
        :sections="sharedDirsSections"
        :installation-id="installation?.id"
        :running-action-ids="runningActionIds"
        :pending-restart-field-ids="pendingRestartFieldIds"
        :field-error-messages="fieldErrorMessages"
        @update-field="handleUpdateSharedDirField"
      />
    </GlobalSettingsMicroSection>
  </div>
</template>

<style scoped>
.storage-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.storage-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--brand-surface-bg);
  border: 1px solid var(--chooser-surface-border);
  color: var(--text-muted);
  transition:
    color 160ms ease,
    background-color 160ms ease,
    border-color 160ms ease;
}

.storage-note-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

.storage-note-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

/* Warning state. Icon `color` is explicit to override the base 0.85 opacity. */
.storage-note.is-warning {
  color: var(--warning);
  border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  font-weight: 500;
}

.storage-note.is-warning .storage-note-icon {
  color: var(--warning);
  opacity: 1;
}

/* Inline warning shown when `useSharedModels` is OFF. */
.storage-pane-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  border: 1px solid var(--warning);
  color: var(--warning);
  font-weight: 500;
}

.storage-pane-warning-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--warning);
}

.storage-pane-warning-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}
</style>
