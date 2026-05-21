<script setup lang="ts">
import { computed, onMounted, useTemplateRef } from 'vue'
import { useTitlePopupAutoResize } from '../composables/useTitlePopupAutoResize'
import { useI18n } from 'vue-i18n'
import { Github, Plus, X } from 'lucide-vue-next'
import GlobalSettingsAccordion from './globalSettings/GlobalSettingsAccordion.vue'
import UpdatesSection from './globalSettings/UpdatesSection.vue'
import SettingsSectionList from '../views/comfyUISettings/SettingsSectionList.vue'
import DirCard from '../components/DirCard.vue'
import type {
  ActionDef,
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
  DetailSection,
} from '../types/ipc'

/**
 * Global Settings popup view.
 *
 * Pure-prop mirror of `InstancePickerView.vue`:
 *  - Receives a `snapshot` prop built main-side by
 *    `buildGlobalSettingsSnapshot` in `src/main/popups/titlePopup.ts`.
 *  - Dispatches mutations through `window.__comfyTitlePopup`. The popup
 *    renderer does NOT have `window.api` — every mutation is a
 *    bridge method.
 *  - Snapshot pushes from main (settings-changed / app-update-state /
 *    installations-changed) repaint the accordions automatically.
 */

interface ModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

interface Snapshot {
  overviewFields: Record<string, unknown>[]
  cacheFields: Record<string, unknown>[]
  advancedFields: Record<string, unknown>[]
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: ModelsDir[]
  modelsSystemDefault: string
  appUpdate: {
    state: Record<string, unknown>
    progress: Record<string, unknown> | null
    isDownloading: boolean
    capabilities: { systemManaged: boolean; canSelfUpdate: boolean }
    installedVersion: string
    platform: string
    lastCheckedAt: number | null
  }
  channelPickerField: Record<string, unknown> | null
  activeInstallationId: string | null
  hasActiveInstall: boolean
  githubUrl: string
  i18n: {
    overview: string
    updates: string
    cache: string
    models: string
    advanced: string
    sharedDirectories: string
  }
}

interface GlobalSettingsBridge {
  close(): void
  /** Ask main to resize the popup view to the given natural height —
   *  used by the ResizeObserver below to track BaseAccordion's
   *  expand/collapse animation. Main clamps to the 720px / 70% host
   *  content-height ceiling, so unbounded growth is impossible. */
  requestSize(height: number): void
  globalSettingsUpdateField(
    fieldId: string,
    value: unknown,
  ): Promise<{ ok: boolean; message?: string }>
  globalSettingsBrowseFolder(defaultPath?: string): Promise<string | null>
  globalSettingsOpenPath(path: string): void
  globalSettingsOpenExternal(url: string): void
  globalSettingsSetModelsDirs(dirs: string[]): Promise<{ ok: boolean }>
  globalSettingsCheckForUpdate(): Promise<{ available: boolean; version?: string; error?: string }>
  globalSettingsDownloadUpdate(): Promise<void>
  globalSettingsInstallUpdate(): void
  globalSettingsSetLastCheckedAt(value: number): void
  globalSettingsRunInstallAction(
    installationId: string,
    actionId: string,
    actionData?: Record<string, unknown>,
  ): Promise<{ ok: boolean; message?: string }>
}

const props = defineProps<{ snapshot: Snapshot }>()
const { t } = useI18n()
const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge }).__comfyTitlePopup

const LAST_CHECKED_KEY = 'globalSettings.lastCheckedAt'

// ---- Section adapters: cast loose-typed snapshot fields to DetailField. ----
const overviewSections = computed<DetailSection[]>(() => [{
  fields: props.snapshot.overviewFields as unknown as DetailField[],
}])
const cacheSections = computed<DetailSection[]>(() => [{
  fields: props.snapshot.cacheFields as unknown as DetailField[],
}])
const advancedSections = computed<DetailSection[]>(() => [{
  fields: props.snapshot.advancedFields as unknown as DetailField[],
}])
const sharedDirsSections = computed<DetailSection[]>(() => [{
  fields: props.snapshot.sharedDirectoriesFields as unknown as DetailField[],
}])
const channelPickerField = computed<DetailField | null>(() =>
  props.snapshot.channelPickerField as unknown as DetailField | null,
)
const appUpdateState = computed<AppUpdateState>(() =>
  props.snapshot.appUpdate.state as unknown as AppUpdateState,
)
const appUpdateProgress = computed<AppUpdateDownloadProgress | null>(() =>
  props.snapshot.appUpdate.progress as unknown as AppUpdateDownloadProgress | null,
)
const platformLabel = computed(() => {
  const p = props.snapshot.appUpdate.platform
  if (p === 'darwin') return 'macOS'
  if (p === 'win32') return 'Windows'
  if (p === 'linux') return 'Linux'
  return p
})

// ---- Mutation handlers — every action routes through the bridge. ----
async function handleUpdateField(field: DetailField, value: unknown): Promise<void> {
  // Path fields' "Open" button reuses the field id with an `__open__`
  // sentinel value. SettingsSectionList's PathField wires this via
  // separate emits, so handle the conventional update flow only.
  await bridge?.globalSettingsUpdateField(field.id, value)
}

function handleOpenExternal(url: string): void {
  if (!url) return
  bridge?.globalSettingsOpenExternal(url)
}

async function handleAddModelsDir(): Promise<void> {
  const picked = await bridge?.globalSettingsBrowseFolder()
  if (!picked) return
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs.push(picked)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleRemoveModelsDir(index: number): Promise<void> {
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  dirs.splice(index, 1)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

async function handleMakePrimary(index: number): Promise<void> {
  const dirs = props.snapshot.modelsDirs.map((d) => d.path)
  const moved = dirs.splice(index, 1)[0]
  if (typeof moved !== 'string') return
  dirs.unshift(moved)
  await bridge?.globalSettingsSetModelsDirs(dirs)
}

function handleOpenModelsDir(path: string): void {
  bridge?.globalSettingsOpenPath(path)
}

// ---- Updates section handlers ----
async function handleUpdateNow(): Promise<void> {
  const kind = (appUpdateState.value as AppUpdateState).kind
  if (kind === 'ready') {
    bridge?.globalSettingsInstallUpdate()
    return
  }
  if (kind === 'available') {
    await bridge?.globalSettingsDownloadUpdate()
    return
  }
  await handleCheckForUpdate()
}

async function handleCheckForUpdate(): Promise<void> {
  try {
    await bridge?.globalSettingsCheckForUpdate()
  } finally {
    const now = Date.now()
    try { window.localStorage.setItem(LAST_CHECKED_KEY, String(now)) } catch { /* noop */ }
    bridge?.globalSettingsSetLastCheckedAt(now)
  }
}

async function handleRunInstallAction(action: ActionDef): Promise<void> {
  const id = props.snapshot.activeInstallationId
  if (!id) return
  await bridge?.globalSettingsRunInstallAction(id, action.id, action.data as Record<string, unknown> | undefined)
}

const headerRef = useTemplateRef<HTMLDivElement>('headerRef')
const bodyRef = useTemplateRef<HTMLDivElement>('bodyRef')
const contentRef = useTemplateRef<HTMLDivElement>('contentRef')

// Fit-to-content resize. The `.global-settings` root is
// `max-height: 100%`-clamped to the popup view's current bounds, so
// observing it directly saturates the natural-height signal once main
// has already resized the popup smaller. The `contentRef` wrapper
// sits inside `overflow-y: auto`, so its `offsetHeight` is the
// unclamped natural height of the accordions in both directions —
// `useTitlePopupAutoResize` re-derives total popup height from
// header + body padding + content + .popup border on every frame of
// the BaseAccordion grid-row transition.
useTitlePopupAutoResize(
  contentRef,
  () => {
    const header = headerRef.value
    const body = bodyRef.value
    const content = contentRef.value
    if (!header || !body || !content) return NaN
    const cs = getComputedStyle(body)
    const bodyPadding = parseFloat(cs.paddingTop || '0') + parseFloat(cs.paddingBottom || '0')
    return header.offsetHeight + bodyPadding + content.offsetHeight + 2
  },
  bridge?.requestSize ? bridge.requestSize.bind(bridge) : undefined,
)

onMounted(() => {
  // Last-checked back-fill: if main's snapshot has no lastCheckedAt but
  // localStorage does, push the localStorage value to main so the next
  // snapshot rebroadcast shows the correct timestamp.
  if (!props.snapshot.appUpdate.lastCheckedAt) {
    try {
      const raw = window.localStorage.getItem(LAST_CHECKED_KEY)
      if (raw) {
        const n = Number(raw)
        if (Number.isFinite(n)) bridge?.globalSettingsSetLastCheckedAt(n)
      }
    } catch { /* noop */ }
  }
})
</script>

<template>
  <div class="global-settings">
    <div ref="headerRef" class="global-settings-header">
      <span class="global-settings-title">{{ t('settingsModal.tabGlobal', 'Settings') }}</span>
      <button
        type="button"
        class="global-settings-close"
        :aria-label="t('common.close', 'Close')"
        @click="bridge?.close()"
      >
        <X :size="14" aria-hidden="true" />
      </button>
    </div>

    <div ref="bodyRef" class="global-settings-body">
      <div ref="contentRef" class="global-settings-content">
      <GlobalSettingsAccordion :title="snapshot.i18n.overview" :default-open="true">
        <SettingsSectionList :sections="overviewSections" @update-field="handleUpdateField" />
        <button
          type="button"
          class="global-settings-github"
          @click="handleOpenExternal(snapshot.githubUrl)"
        >
          <Github :size="14" aria-hidden="true" />
          <span>GitHub</span>
        </button>
      </GlobalSettingsAccordion>

      <GlobalSettingsAccordion :title="snapshot.i18n.updates">
        <UpdatesSection
          :state="appUpdateState"
          :progress="appUpdateProgress"
          :is-downloading="snapshot.appUpdate.isDownloading"
          :checking="false"
          :last-checked-at="snapshot.appUpdate.lastCheckedAt"
          :installed-version="snapshot.appUpdate.installedVersion"
          :platform-label="platformLabel"
          :channel-picker-field="channelPickerField"
          @update-now="handleUpdateNow"
          @check-for-update="handleCheckForUpdate"
          @install-action="handleRunInstallAction"
        />
      </GlobalSettingsAccordion>

      <GlobalSettingsAccordion :title="snapshot.i18n.cache">
        <!-- Storage bucket: Cache, Models, and Shared Directories. The
             three were separate accordions in the original handoff but
             share one mental model ("where files live on disk") so they
             collapse into one section. Three sub-groups keep the rows
             scannable without subtitles. -->
        <div class="global-settings-subgroup">
          <SettingsSectionList :sections="cacheSections" @update-field="handleUpdateField" />
        </div>
        <div class="global-settings-subgroup">
          <div class="global-settings-subgroup-title">{{ snapshot.i18n.models }}</div>
          <div class="global-settings-models">
            <DirCard
              v-for="(d, i) in snapshot.modelsDirs"
              :key="d.path"
              :path="d.path"
              :is-primary="d.isPrimary"
              :is-default="d.isDefault"
              @open="handleOpenModelsDir(d.path)"
              @remove="handleRemoveModelsDir(i)"
              @make-primary="handleMakePrimary(i)"
            />
            <button type="button" class="global-settings-add-dir" @click="handleAddModelsDir">
              <Plus :size="14" aria-hidden="true" />
              <span>{{ t('models.addDir', 'Add directory') }}</span>
            </button>
          </div>
        </div>
        <div class="global-settings-subgroup">
          <div class="global-settings-subgroup-title">{{ snapshot.i18n.sharedDirectories }}</div>
          <SettingsSectionList :sections="sharedDirsSections" @update-field="handleUpdateField" />
        </div>
      </GlobalSettingsAccordion>

      <GlobalSettingsAccordion :title="snapshot.i18n.advanced">
        <SettingsSectionList :sections="advancedSections" @update-field="handleUpdateField" />
      </GlobalSettingsAccordion>
      </div>
    </div>
  </div>
</template>

<style scoped>
.global-settings {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 100%;
  color: var(--neutral-100);
  font-size: 14px;
}

.global-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--chooser-surface-border);
  font-weight: 600;
}

.global-settings-title {
  font-size: 14px;
  color: var(--neutral-100);
}

.global-settings-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  border-radius: 6px;
  color: var(--neutral-100);
  cursor: pointer;
  transition: background-color 100ms ease;
}

.global-settings-close:hover,
.global-settings-close:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.global-settings-body {
  padding: 12px 16px;
  overflow-y: auto;
}

/* Holds the accordions and owns the inter-accordion gap. Lives inside
 * `.global-settings-body` so the body keeps `overflow-y: auto` for the
 * ceiling-clamped overflow case, while this wrapper reports the
 * unclamped natural content height to the ResizeObserver above. */
.global-settings-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.global-settings-github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0 0 0;
  border: none;
  background: transparent;
  color: var(--neutral-100);
  opacity: 0.67;
  font-size: 12px;
  cursor: pointer;
  align-self: flex-start;
  transition: opacity 100ms ease;
}

.global-settings-github:hover,
.global-settings-github:focus-visible {
  opacity: 1;
  outline: none;
}

.global-settings-subgroup {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.global-settings-subgroup + .global-settings-subgroup {
  padding-top: 12px;
  border-top: 1px solid var(--chooser-surface-border);
}

.global-settings-subgroup-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: rgba(194, 191, 185, 0.75);
}

.global-settings-models {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* One-step density tightening for the popup vs. the legacy
 * `SettingsView`. Scoped via `:deep()` so SettingsSectionList's field
 * chrome inherits without us forking the component. Real class names
 * come from `SettingsSectionList.vue` (`.settings-v2-field`) and the
 * shared `BaseInput` / `BaseSelect` primitives (`.ui-input`,
 * `.ui-input-control`, `.ui-select-trigger`). */
.global-settings :deep(.settings-v2-field) {
  gap: 4px;
}

.global-settings :deep(.settings-v2-field-label) {
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
  font-weight: 400;
}

.global-settings :deep(.ui-input),
.global-settings :deep(.ui-select-trigger) {
  min-height: 28px;
  border-radius: 6px;
}

.global-settings :deep(.ui-input-control),
.global-settings :deep(.ui-select-trigger) {
  font-size: 13px;
}

.global-settings :deep(.ui-input-control) {
  padding: 4px 10px;
}

/* The default trailing-slot button is a 28x28 square in BaseInput —
 * shrink to match the tightened input height. */
.global-settings :deep(.ui-input-trailing button) {
  width: 26px;
  height: 26px;
}

.global-settings-add-dir {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px dashed var(--chooser-surface-border);
  background: transparent;
  border-radius: 8px;
  color: var(--neutral-100);
  cursor: pointer;
  align-self: flex-start;
  transition: background-color 100ms ease;
}

.global-settings-add-dir:hover,
.global-settings-add-dir:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}
</style>
