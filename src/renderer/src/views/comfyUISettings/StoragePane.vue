<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Info } from 'lucide-vue-next'
import { useModal } from '../../composables/useModal'
import GlobalSettingsMicroSection from '../../comfyTitlePopup/globalSettings/GlobalSettingsMicroSection.vue'
import ModelsDirList from '../../comfyTitlePopup/globalSettings/ModelsDirList.vue'
import SettingsSectionList from './SettingsSectionList.vue'
import type { DetailField, DetailSection, Installation } from '../../types/ipc'

/**
 * Storage tab pane for the instance-picker settings.
 *
 * Composes:
 *  - Global shared-models UI (model directories + shared-directory
 *    fields) — driven by the same `globalSettingsSnapshot` the popup
 *    already streams, and mutated through the popup's existing
 *    `__comfyTitlePopup.globalSettings*` bridge methods. This mirrors
 *    the old Global Settings popup view exactly — only the render
 *    surface changed.
 *  - Per-install storage section (`useSharedModels`,
 *    `useSharedInputOutput`, and the per-install `inputDir` /
 *    `outputDir` path pickers shown only when shared input/output is
 *    off), sourced from `props.sections`. Git installs omit this
 *    section entirely.
 *
 * Top-of-tab note swaps between an informational muted line and a
 * warning-colour restart prompt when the user has touched any field
 * in the tab during this session. The warning refers to restarting
 * the desktop application — distinct from the per-field "Restart to
 * apply" pill on the toggles, which restarts the running Comfy
 * instance.
 *
 * Turning `useSharedModels` off is rare and easy to mistake for "free
 * up disk space" when the real effect is "this instance can no longer
 * see any of your downloaded models". We render an inline warning
 * banner directly below the toggle whenever it's off so the user can't
 * miss the consequence.
 */

interface ModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
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
  /** Global snapshot fields the popup streams via
   *  `onGlobalSettingsSnapshot`. Passed in as a prop so the picker view
   *  doesn't subscribe twice. */
  snapshot: StorageSnapshot
  /** Per-install storage sections — `useSharedModels` /
   *  `useSharedInputOutput` toggles and the per-install `inputDir` /
   *  `outputDir` path pickers for desktop / portable installs. Git
   *  installs omit this section entirely. */
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

/** Tracks whether the user has touched ANY global field in this tab
 *  session. Global writes go through `globalSettingsSetModelsDirs` /
 *  `globalSettingsUpdateField`, which persist immediately — there is
 *  no save step, only the intent-to-have-changed signal that drives
 *  the warning-color swap on the top-of-tab note. */
const globalTouched = ref(false)

watch(
  () => props.installation?.id ?? null,
  () => {
    globalTouched.value = false
  }
)

/** Per-install storage toggles + path fields touch global state
 *  (settings.json) at restart, so any pending edit also triggers the
 *  warning-coloured restart prompt. */
const PER_INSTALL_STORAGE_FIELD_IDS = ['useSharedModels', 'useSharedInputOutput', 'inputDir', 'outputDir']

const showRestartWarning = computed(() => {
  if (globalTouched.value) return true
  return PER_INSTALL_STORAGE_FIELD_IDS.some((id) => props.pendingRestartFieldIds.has(id))
})

/** Note-bar leading icon. Computed (not inlined as `:is`-via-import)
 *  so the symbols are typed as used — otherwise `<script setup>`
 *  doesn't count `:is` template references as imports. */
const noteIcon = computed(() => (showRestartWarning.value ? AlertTriangle : Info))

const sharedDirsSections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.sharedDirectoriesFields as unknown as DetailField[] },
])

/** Flat view of every field across the per-install sections — used
 *  by lookups below so the template stays declarative. */
const perInstallFields = computed<DetailField[]>(() =>
  props.sections.flatMap((s) => s.fields ?? [])
)

function findField(id: string): DetailField | undefined {
  return perInstallFields.value.find((f) => f.id === id)
}

/** Per-install `useSharedModels` toggle value (defaults to on when
 *  the field is absent). When off, the global Shared Models list
 *  below is irrelevant for THIS install — we hide it and replace it
 *  with an inline warning so the user sees the consequence. */
const useSharedModelsEnabled = computed<boolean>(() => {
  const f = findField('useSharedModels')
  return f ? f.value !== false : true
})

/** Per-install `useSharedInputOutput` toggle value (defaults to on).
 *  When off, the global Shared Directories list below is irrelevant
 *  and per-install `inputDir` / `outputDir` pickers are shown
 *  instead. */
const useSharedInputOutputEnabled = computed<boolean>(() => {
  const f = findField('useSharedInputOutput')
  return f ? f.value !== false : true
})

/** Sections passed down to the per-install settings list. Filters out
 *  the per-install `inputDir` / `outputDir` fields when shared
 *  input/output is on — they're not meaningful in that mode and would
 *  just clutter the common case. */
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

    <!-- Per-install toggles + per-install path pickers (when shared
         input/output is off) sit above the global model / directory
         lists so the user sees "this instance opts in to shared
         storage" before scrolling through the global dirs. Hidden
         for sources that opt out (git installs) where main emits no
         storage section. -->
    <SettingsSectionList
      v-if="perInstallSections.length > 0"
      :sections="perInstallSections"
      :installation-id="installation?.id"
      :running-action-ids="runningActionIds"
      :pending-restart-field-ids="pendingRestartFieldIds"
      :field-error-messages="fieldErrorMessages"
      @update-field="handleUpdatePerInstallField"
    />

    <!-- Inline warning when shared models is OFF. Surfaces a state
         most users would otherwise discover only when a workflow
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

    <!-- Shared Models only applies when this install opts into shared
         models — hide it otherwise so the user isn't configuring a
         list that has no effect here. -->
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

    <!-- Shared Directories (input/output) only applies when this
         install opts into shared input/output — when off, the
         per-install path pickers above cover the same ground. -->
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

/* Warning state — solid `--warning` border + icon so the row reads
 * as a banner, not chrome. Background + border + icon all shift to
 * the warning token. Icon `color` is explicit so it overrides the
 * base `.storage-note-icon { opacity: 0.85 }`. */
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

/* Inline warning when `useSharedModels` is OFF. Sits between the
 * per-install toggles and the (now-hidden) global Shared Models list
 * so the consequence of toggling off is impossible to miss. Uses the
 * same warning token as the top-of-tab restart banner. */
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
