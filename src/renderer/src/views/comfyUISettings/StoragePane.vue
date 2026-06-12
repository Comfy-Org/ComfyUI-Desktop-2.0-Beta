<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Info } from 'lucide-vue-next'
import { useModal } from '../../composables/useModal'
import GlobalSettingsMicroSection from '../../comfyTitlePopup/globalSettings/GlobalSettingsMicroSection.vue'
import ModelsDirList from '../../comfyTitlePopup/globalSettings/ModelsDirList.vue'
import StorageDirRow from './StorageDirRow.vue'
import BooleanToggle from './BooleanToggle.vue'
import ExtraModelPathsModal, { type ExtraModelPathSection } from './ExtraModelPathsModal.vue'
import InfoTooltip from '../../components/InfoTooltip.vue'
import type { DetailField, DetailSection, Installation } from '../../types/ipc'

/** Storage tab pane for the instance-picker settings. Composes the global
 *  shared-models UI (via the popup's `__comfyTitlePopup.globalSettings*`
 *  bridge) with the per-install storage section from `props.sections`. The
 *  `Use Shared *` toggles live inside their respective Models / Input-Output
 *  groups. */

interface ModelsDir {
  path: string
  isPrimary: boolean
  locked?: boolean
  promotable?: boolean
  /** Read-only row for the install's `extra_model_paths.yaml` file (opens a modal). */
  kind?: 'extra'
  /** Globally-shared dir → shows the shared badge on its icon. */
  shared?: boolean
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
  globalSettingsRevealPath(path: string): void
  globalSettingsSetModelsDirs(dirs: string[]): Promise<{ ok: boolean }>
  platform?: string
}

interface Props {
  installation: Installation | null
  /** Global snapshot fields, passed as a prop so the picker doesn't subscribe twice. */
  snapshot: StorageSnapshot
  /** Per-install storage sections; git installs omit them entirely. */
  sections: DetailSection[]
  pendingRestartFieldIds: Set<string>
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'update-field': [field: DetailField, value: unknown]
  /** Ask the parent to re-fetch detail sections (refreshes custom-paths on-disk
   *  status, computed once per fetch in the main process). */
  refresh: []
}>()

const { t } = useI18n()
const modal = useModal()

const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge })
  .__comfyTitlePopup

/** Platform-aware path equality. Renderer paths are already absolute (browse
 *  results, backend-computed defaults, stored dirs), so no resolve is needed. */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  return bridge?.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

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
const PER_INSTALL_STORAGE_FIELD_IDS = [
  'useSharedModels',
  'useSharedInputOutput',
  'modelDirs',
  'modelDirsPrimary',
  'inputDir',
  'outputDir',
]

const showRestartWarning = computed(() => {
  if (globalTouched.value) return true
  return PER_INSTALL_STORAGE_FIELD_IDS.some((id) => props.pendingRestartFieldIds.has(id))
})

// Computed (not inlined `:is`) so `<script setup>` counts the icon imports as used.
const noteIcon = computed(() => (showRestartWarning.value ? AlertTriangle : Info))

/** Global shared input/output fields from the snapshot, keyed by id so the
 *  shared-on rows render with the same readonly path-row style as shared-off. */
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

const perInstallFields = computed<DetailField[]>(() =>
  props.sections.flatMap((s) => s.fields ?? [])
)

function findField(id: string): DetailField | undefined {
  return perInstallFields.value.find((f) => f.id === id)
}

/** Read-only dirs from the install's `extra_model_paths.yaml`, resolved in the
 *  main process and passed as a hidden field, grouped by section. */
interface ExtraModelPathsView {
  yamlPath: string
  exists: boolean
  sections: ExtraModelPathSection[]
}
const extraModelPaths = computed<ExtraModelPathsView>(() => {
  const v = findField('extraModelPaths')?.value as ExtraModelPathsView | undefined
  return v ?? { yamlPath: '', exists: false, sections: [] }
})
const extraSections = computed<ExtraModelPathSection[]>(() => extraModelPaths.value.sections)

/** The install's `extra_model_paths.yaml` as a single read-only row (its
 *  sections are shown in the detail modal). ComfyUI loads this file regardless
 *  of the shared-models toggle, so the row appends to both lists. */
const extraModelRows = computed<ModelsDir[]>(() =>
  extraSections.value.length > 0
    ? [{ path: extraModelPaths.value.yamlPath, isPrimary: false, kind: 'extra' }]
    : []
)

// --- Custom model paths detail modal --------------------------------------

// The modal reads `extraSections` live, so a refresh updates it in place.
const extraModalOpen = ref(false)

function openExtraDetails(row: ModelsDir | undefined): void {
  if (row?.kind === 'extra') extraModalOpen.value = true
}

function handleSharedModelDetails(index: number): void {
  openExtraDetails(sharedModelDirs.value[index])
}
function handleInstanceModelDetails(index: number): void {
  openExtraDetails(instanceModelDirs.value[index])
}
function closeExtraModal(): void {
  extraModalOpen.value = false
}
function handleRefreshExtraPaths(): void {
  emit('refresh')
}

function persistField(id: string, value: unknown): void {
  const field = findField(id)
  if (field) emit('update-field', field, value)
}

/** `useSharedModels` toggle (defaults on). When off, the global Shared
 *  Models list is hidden and replaced with the per-instance list + warning. */
const useSharedModelsField = computed(() => findField('useSharedModels'))
const useSharedModelsEnabled = computed<boolean>(() => {
  const f = useSharedModelsField.value
  return f ? f.value !== false : true
})

/** `useSharedInputOutput` toggle (defaults on). When off, the global Shared
 *  Directories list is replaced with the per-install readonly path rows. */
const useSharedInputOutputField = computed(() => findField('useSharedInputOutput'))
const useSharedInputOutputEnabled = computed<boolean>(() => {
  const f = useSharedInputOutputField.value
  return f ? f.value !== false : true
})

function handleToggleField(field: DetailField | undefined, value: boolean): void {
  if (field) emit('update-field', field, value)
}

// --- Per-instance model directories (shared models off) -------------------

function currentExtras(): string[] {
  const v = findField('modelDirs')?.value
  return Array.isArray(v) ? (v as string[]) : []
}

/** The install's own models dir, computed by the backend (never persisted). */
const installOwnModelsDir = computed<string>(() => {
  const v = findField('installModelsDir')?.value
  return typeof v === 'string' ? v : ''
})

/** Validated external primary: a `modelDirs` entry, else null (= install-own). */
const instancePrimary = computed<string | null>(() => {
  const raw = findField('modelDirsPrimary')?.value
  if (typeof raw !== 'string') return null
  return currentExtras().some((d) => samePath(d, raw)) ? raw : null
})

/** Combined list with the primary on top: the install-own dir leads only when
 *  it's the primary (the default), otherwise it sinks to the bottom as a
 *  locked, undeletable row below the external extras. */
const instanceModelDirs = computed<ModelsDir[]>(() => {
  const own = installOwnModelsDir.value
  const primary = instancePrimary.value
  const ownRow: ModelsDir | null = own
    ? { path: own, isPrimary: primary === null, locked: true }
    : null
  const extraRows: ModelsDir[] = currentExtras().map((p) => ({
    path: p,
    isPrimary: primary !== null && samePath(p, primary),
    locked: false,
  }))
  const base = ownRow?.isPrimary
    ? [ownRow, ...extraRows]
    : ownRow
      ? [...extraRows, ownRow]
      : extraRows
  return [...base, ...extraModelRows.value]
})

async function handleAddInstanceModelDir(): Promise<void> {
  const picked = await bridge?.globalSettingsBrowseFolder()
  if (!picked) return
  if (samePath(picked, installOwnModelsDir.value)) return
  const extras = currentExtras()
  if (extras.some((d) => samePath(d, picked))) return
  persistField('modelDirs', [...extras, picked])
}

async function handleRemoveInstanceModelDir(index: number): Promise<void> {
  const row = instanceModelDirs.value[index]
  if (!row || row.locked) return // the install-own row can't be removed
  const extras = currentExtras()
  if (!extras.some((d) => samePath(d, row.path))) return
  const ok = await modal.confirm({
    title: t('models.removeInstanceDirTitle', 'Remove model directory?'),
    message: t(
      'models.removeInstanceDirConfirm',
      "This won't delete any files. You can re-add the directory later from this list."
    ),
    confirmLabel: t('models.removeDir', 'Remove'),
    confirmStyle: 'danger',
  })
  if (!ok) return
  if (instancePrimary.value !== null && samePath(row.path, instancePrimary.value)) {
    persistField('modelDirsPrimary', null)
  }
  persistField(
    'modelDirs',
    extras.filter((d) => !samePath(d, row.path))
  )
}

function handleMakeInstancePrimary(index: number): void {
  const row = instanceModelDirs.value[index]
  if (!row || row.kind === 'extra') return
  // The locked install-own row becoming primary means "no external primary".
  persistField('modelDirsPrimary', row.locked ? null : row.path)
}

function handleOpenInstanceModelDir(index: number): void {
  const dir = instanceModelDirs.value[index]
  if (dir) bridge?.globalSettingsOpenPath(dir.path)
}

// --- Per-instance input / output dirs (shared I/O off) --------------------

function effectiveDir(storedId: string, defaultId: string): string {
  const stored = findField(storedId)?.value
  if (typeof stored === 'string' && stored.trim()) return stored
  const def = findField(defaultId)?.value
  return typeof def === 'string' ? def : ''
}

function isOverridden(storedId: string): boolean {
  const stored = findField(storedId)?.value
  return typeof stored === 'string' && stored.trim().length > 0
}

const effectiveInputDir = computed(() => effectiveDir('inputDir', 'inputDirDefault'))
const effectiveOutputDir = computed(() => effectiveDir('outputDir', 'outputDirDefault'))
const inputOverridden = computed(() => isOverridden('inputDir'))
const outputOverridden = computed(() => isOverridden('outputDir'))

function defaultOf(defaultId: string): string {
  const v = findField(defaultId)?.value
  return typeof v === 'string' ? v : ''
}

async function browseDir(storedId: string, defaultId: string, current: string): Promise<void> {
  const picked = await bridge?.globalSettingsBrowseFolder(current || undefined)
  if (!picked) return
  // Selecting the computed default clears the override so a clone derives its
  // own path instead of pointing back at this install.
  persistField(storedId, samePath(picked, defaultOf(defaultId)) ? '' : picked)
}

function handleBrowseInputDir(): void {
  void browseDir('inputDir', 'inputDirDefault', effectiveInputDir.value)
}
function handleBrowseOutputDir(): void {
  void browseDir('outputDir', 'outputDirDefault', effectiveOutputDir.value)
}
function handleResetInputDir(): void {
  persistField('inputDir', '')
}
function handleResetOutputDir(): void {
  persistField('outputDir', '')
}
function handleOpenPath(path: string): void {
  if (path) bridge?.globalSettingsOpenPath(path)
}
function handleRevealPath(path: string): void {
  if (path) bridge?.globalSettingsRevealPath(path)
}

// --- Global shared models (shared models on) ------------------------------

/** Displayed list when shared models is on: the global shared dirs (primary on
 *  top), then the install's own models dir as a locked, non-promotable row at
 *  the bottom. ComfyUI always reads from it, but the default download target is
 *  a global shared dir, so it's never the primary here. */
const sharedModelDirs = computed<ModelsDir[]>(() => {
  const rows: ModelsDir[] = props.snapshot.modelsDirs.map((d) => ({
    path: d.path,
    isPrimary: d.isPrimary,
    locked: false,
    shared: true,
  }))
  const own = installOwnModelsDir.value
  if (own) rows.push({ path: own, isPrimary: false, locked: true, promotable: false })
  return [...rows, ...extraModelRows.value]
})

/** Index of a displayed row's path within the editable global shared dirs. */
function snapshotIndexOf(dirPath: string): number {
  return props.snapshot.modelsDirs.findIndex((d) => samePath(d.path, dirPath))
}

async function handleAddModelsDir(): Promise<void> {
  const picked = await bridge?.globalSettingsBrowseFolder()
  if (!picked) return
  globalTouched.value = true
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs.push(picked)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleRemoveModelsDir(index: number): Promise<void> {
  const row = sharedModelDirs.value[index]
  if (!row || row.locked) return
  const i = snapshotIndexOf(row.path)
  if (i < 0) return
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
  dirs.splice(i, 1)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleMakePrimary(index: number): Promise<void> {
  const row = sharedModelDirs.value[index]
  if (!row || row.locked) return
  const i = snapshotIndexOf(row.path)
  if (i < 0) return
  globalTouched.value = true
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  const moved = dirs.splice(i, 1)[0]
  if (typeof moved !== 'string') return
  dirs.unshift(moved)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleChangeModelsDir(index: number): Promise<void> {
  const row = sharedModelDirs.value[index]
  if (!row || row.locked) return
  const i = snapshotIndexOf(row.path)
  const current = props.snapshot.modelsDirs[i]?.path
  const picked = await bridge?.globalSettingsBrowseFolder(current)
  if (!picked || picked === current) return
  globalTouched.value = true
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs[i] = picked
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

function handleOpenModelsDir(index: number): void {
  const dir = sharedModelDirs.value[index]
  if (dir) bridge?.globalSettingsOpenPath(dir.path)
}

async function browseSharedDir(field: DetailField | undefined): Promise<void> {
  if (!field) return
  const picked = await bridge?.globalSettingsBrowseFolder(sharedFieldPath(field) || undefined)
  if (!picked || picked === field.value) return
  globalTouched.value = true
  await bridge?.globalSettingsUpdateField(field.id, picked)
}

function handleBrowseSharedInput(): void {
  void browseSharedDir(sharedInputField.value)
}
function handleBrowseSharedOutput(): void {
  void browseSharedDir(sharedOutputField.value)
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

    <!-- Models group: the Use-Shared-Models toggle lives here, above the list
         it controls. -->
    <GlobalSettingsMicroSection
      :title="t('settings.modelStorage', 'Models')"
      :tooltip="t('tooltips.sharedModels')"
    >
      <div v-if="useSharedModelsField" class="storage-toggle-row">
        <label class="storage-toggle-label">
          <span>{{ t('common.useSharedModels', 'Use Shared Models') }}</span>
          <InfoTooltip :text="t('tooltips.useSharedModels')" />
        </label>
        <BooleanToggle
          :field="useSharedModelsField"
          @update="(v) => handleToggleField(useSharedModelsField, v)"
        />
      </div>

      <!-- Shared on: locked install-own dir (always used) + global shared list. -->
      <ModelsDirList
        v-if="useSharedModelsEnabled"
        :dirs="sharedModelDirs"
        @change="handleChangeModelsDir"
        @remove="handleRemoveModelsDir"
        @make-primary="handleMakePrimary"
        @open="handleOpenModelsDir"
        @details="handleSharedModelDetails"
        @add="handleAddModelsDir"
      />

      <!-- Shared off: per-instance list (locked install-own row). -->
      <template v-else>
        <ModelsDirList
          :dirs="instanceModelDirs"
          @open="handleOpenInstanceModelDir"
          @remove="handleRemoveInstanceModelDir"
          @make-primary="handleMakeInstancePrimary"
          @details="handleInstanceModelDetails"
          @add="handleAddInstanceModelDir"
        />
      </template>
    </GlobalSettingsMicroSection>

    <!-- Input/Output group: the Use-Shared-I/O toggle lives here. -->
    <GlobalSettingsMicroSection :title="t('settings.inputOutputStorage', 'Input & Output')">
      <div v-if="useSharedInputOutputField" class="storage-toggle-row">
        <label class="storage-toggle-label">
          <span>{{ t('common.useSharedInputOutput', 'Use Shared Input/Output Folders') }}</span>
          <InfoTooltip :text="t('tooltips.useSharedInputOutput')" />
        </label>
        <BooleanToggle
          :field="useSharedInputOutputField"
          @update="(v) => handleToggleField(useSharedInputOutputField, v)"
        />
      </div>

      <!-- Shared on: global shared input/output dirs, same readonly path-row
           style as shared-off. -->
      <template v-if="useSharedInputOutputEnabled">
        <StorageDirRow
          v-if="sharedInputField"
          :label="sharedInputField.label || t('common.perInstallInputDir', 'Input Directory')"
          :path="sharedFieldPath(sharedInputField)"
          shared
          @open="handleOpenPath(sharedFieldPath(sharedInputField))"
          @browse="handleBrowseSharedInput"
        />
        <StorageDirRow
          v-if="sharedOutputField"
          :label="sharedOutputField.label || t('common.perInstallOutputDir', 'Output Directory')"
          :path="sharedFieldPath(sharedOutputField)"
          shared
          @open="handleOpenPath(sharedFieldPath(sharedOutputField))"
          @browse="handleBrowseSharedOutput"
        />
      </template>

      <!-- Shared off: readonly effective path rows with browse + reset. -->
      <template v-else>
        <StorageDirRow
          :label="t('common.perInstallInputDir', 'Input Directory')"
          :path="effectiveInputDir"
          :tag="!inputOverridden ? t('models.default', 'default') : ''"
          :resettable="inputOverridden"
          @open="handleOpenPath(effectiveInputDir)"
          @browse="handleBrowseInputDir"
          @reset="handleResetInputDir"
        />
        <StorageDirRow
          :label="t('common.perInstallOutputDir', 'Output Directory')"
          :path="effectiveOutputDir"
          :tag="!outputOverridden ? t('models.default', 'default') : ''"
          :resettable="outputOverridden"
          @open="handleOpenPath(effectiveOutputDir)"
          @browse="handleBrowseOutputDir"
          @reset="handleResetOutputDir"
        />
      </template>
    </GlobalSettingsMicroSection>

    <!-- Read-only details for the install's extra_model_paths.yaml file,
         opened from its row in the models list above. -->
    <ExtraModelPathsModal
      :open="extraModalOpen"
      :sections="extraSections"
      :yaml-path="extraModelPaths.yamlPath"
      @close="closeExtraModal"
      @open-path="handleOpenPath"
      @reveal-path="handleRevealPath"
      @refresh="handleRefreshExtraPaths"
    />
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

/* Use-Shared-* toggle row sitting at the top of each storage group. */
.storage-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 36px;
}

.storage-toggle-label {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  font-size: 13px;
  color: var(--neutral-100);
}

.storage-toggle-label > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
