<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Github,
  HardDrive,
  Plus,
  RefreshCcw,
  Settings2,
  SlidersHorizontal,
  Star,
  X
} from 'lucide-vue-next'
import UpdatesSection from './globalSettings/UpdatesSection.vue'
import SettingsSectionList from '../views/comfyUISettings/SettingsSectionList.vue'
import DirCard from '../components/DirCard.vue'
import type {
  ActionDef,
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
  DetailSection
} from '../types/ipc'

/**
 * Global Settings popup view — two-pane tabbed card.
 *
 * Receives a `snapshot` prop built main-side by `buildGlobalSettingsSnapshot`
 * in `src/main/popups/titlePopup.ts` and dispatches mutations through
 * `window.__comfyTitlePopup`. The popup renderer does NOT have
 * `window.api` — every mutation is a bridge method.
 *
 * The popup itself is sized once main-side from host content bounds
 * (fluid clamp on width + height); the right pane scrolls when its
 * content overflows so switching tabs never resizes the popup.
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
  githubStars: number | null
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
  globalSettingsUpdateField(
    fieldId: string,
    value: unknown
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
    actionData?: Record<string, unknown>
  ): Promise<{ ok: boolean; message?: string }>
}

const props = defineProps<{ snapshot: Snapshot }>()
const { t } = useI18n()
const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge }).__comfyTitlePopup

const LAST_CHECKED_KEY = 'globalSettings.lastCheckedAt'

type TabId = 'general' | 'updates' | 'cache' | 'storage' | 'advanced'
const activeTab = ref<TabId>('general')

const tabs = computed<{ id: TabId; label: string; icon: Component }[]>(() => [
  { id: 'general', label: props.snapshot.i18n.overview, icon: Settings2 },
  { id: 'updates', label: props.snapshot.i18n.updates, icon: RefreshCcw },
  { id: 'cache', label: props.snapshot.i18n.cache, icon: HardDrive },
  { id: 'storage', label: props.snapshot.i18n.models, icon: HardDrive },
  { id: 'advanced', label: props.snapshot.i18n.advanced, icon: SlidersHorizontal }
])

const overviewSections = computed<DetailSection[]>(() => [
  {
    fields: props.snapshot.overviewFields as unknown as DetailField[]
  }
])
const cacheSections = computed<DetailSection[]>(() => [
  {
    fields: props.snapshot.cacheFields as unknown as DetailField[]
  }
])
const advancedSections = computed<DetailSection[]>(() => [
  {
    fields: props.snapshot.advancedFields as unknown as DetailField[]
  }
])
const sharedDirsSections = computed<DetailSection[]>(() => [
  {
    fields: props.snapshot.sharedDirectoriesFields as unknown as DetailField[]
  }
])
const channelPickerField = computed<DetailField | null>(
  () => props.snapshot.channelPickerField as unknown as DetailField | null
)
const appUpdateState = computed<AppUpdateState>(
  () => props.snapshot.appUpdate.state as unknown as AppUpdateState
)
const appUpdateProgress = computed<AppUpdateDownloadProgress | null>(
  () => props.snapshot.appUpdate.progress as unknown as AppUpdateDownloadProgress | null
)
const platformLabel = computed(() => {
  const p = props.snapshot.appUpdate.platform
  if (p === 'darwin') return 'macOS'
  if (p === 'win32') return 'Windows'
  if (p === 'linux') return 'Linux'
  return p
})

async function handleUpdateField(field: DetailField, value: unknown): Promise<void> {
  await bridge?.globalSettingsUpdateField(field.id, value)
}

function handleOpenExternal(url: string): void {
  if (!url) return
  bridge?.globalSettingsOpenExternal(url)
}

const starCountLabel = computed(() => {
  const n = props.snapshot.githubStars
  if (n == null) return ''
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(n)
})

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
    try {
      window.localStorage.setItem(LAST_CHECKED_KEY, String(now))
    } catch {
      /* noop */
    }
    bridge?.globalSettingsSetLastCheckedAt(now)
  }
}

async function handleRunInstallAction(action: ActionDef): Promise<void> {
  const id = props.snapshot.activeInstallationId
  if (!id) return
  await bridge?.globalSettingsRunInstallAction(
    id,
    action.id,
    action.data as Record<string, unknown> | undefined
  )
}

function handleTabKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const ids = tabs.value.map((t) => t.id)
  const idx = ids.indexOf(activeTab.value)
  const next =
    event.key === 'ArrowDown' ? (idx + 1) % ids.length : (idx - 1 + ids.length) % ids.length
  activeTab.value = ids[next] as TabId
}

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
    } catch {
      /* noop */
    }
  }
})
</script>

<template>
  <div class="global-settings">
    <header class="gs-header">
      <h2 class="gs-title">{{ t('settingsModal.tabGlobal', 'Desktop Settings') }}</h2>
      <button
        type="button"
        class="gs-close"
        :aria-label="t('common.close', 'Close')"
        @click="bridge?.close()"
      >
        <X :size="16" aria-hidden="true" />
      </button>
    </header>

    <div class="gs-body">
      <nav class="gs-tabs" role="tablist" aria-orientation="vertical" @keydown="handleTabKey">
        <button
          v-for="tab in tabs"
          :id="`gs-tab-${tab.id}`"
          :key="tab.id"
          type="button"
          class="gs-tab"
          :class="{ active: activeTab === tab.id }"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="`gs-panel-${tab.id}`"
          :tabindex="activeTab === tab.id ? 0 : -1"
          @click="activeTab = tab.id"
        >
          <component :is="tab.icon" :size="14" aria-hidden="true" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>

      <section
        :id="`gs-panel-${activeTab}`"
        class="gs-pane"
        role="tabpanel"
        :aria-labelledby="`gs-tab-${activeTab}`"
      >
        <template v-if="activeTab === 'general'">
          <SettingsSectionList :sections="overviewSections" @update-field="handleUpdateField" />
          <div class="gs-github-row">
            <button type="button" class="gs-github" @click="handleOpenExternal(snapshot.githubUrl)">
              <Github :size="14" aria-hidden="true" />
              <span>GitHub</span>
            </button>
            <button
              v-if="snapshot.githubStars != null"
              type="button"
              class="gs-github-stars"
              :aria-label="`${snapshot.githubStars} GitHub stars`"
              @click="handleOpenExternal(snapshot.githubUrl)"
            >
              <Star :size="12" class="gs-github-stars-icon" aria-hidden="true" />
              <span>{{ starCountLabel }}</span>
            </button>
          </div>
        </template>

        <template v-else-if="activeTab === 'updates'">
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
        </template>

        <template v-else-if="activeTab === 'cache'">
          <SettingsSectionList :sections="cacheSections" @update-field="handleUpdateField" />
        </template>

        <template v-else-if="activeTab === 'storage'">
          <div class="gs-subgroup">
            <div class="gs-subgroup-title">{{ snapshot.i18n.models }}</div>
            <div class="gs-models">
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
              <button type="button" class="gs-add-dir" @click="handleAddModelsDir">
                <Plus :size="14" aria-hidden="true" />
                <span>{{ t('models.addDir', 'Add directory') }}</span>
              </button>
            </div>
          </div>
          <div class="gs-subgroup">
            <div class="gs-subgroup-title">{{ snapshot.i18n.sharedDirectories }}</div>
            <SettingsSectionList :sections="sharedDirsSections" @update-field="handleUpdateField" />
          </div>
        </template>

        <template v-else>
          <SettingsSectionList :sections="advancedSections" @update-field="handleUpdateField" />
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.global-settings {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  color: var(--neutral-100);
  font-size: 14px;
}

.gs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
  flex: 0 0 auto;
}

.gs-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: color-mix(in oklab, var(--text) 90%, transparent);
}

.gs-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  background: color-mix(in oklab, var(--text) 4%, transparent);
  border-radius: 8px;
  color: var(--neutral-100);
  opacity: 0.7;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    opacity 120ms ease;
}

.gs-close:hover,
.gs-close:focus-visible {
  opacity: 1;
  background: color-mix(in oklab, var(--neutral-950) 85%, transparent);
  border-color: color-mix(in oklab, var(--neutral-100) 44%, transparent);
  outline: none;
}

.gs-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}

.gs-tabs {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 196px;
  width: 196px;
  padding: 12px 8px;
  background: var(--neutral-800);
  border-right: 1px solid var(--chooser-surface-border);
  overflow-y: auto;
}

.gs-tab {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--neutral-100);
  opacity: 0.72;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 100ms ease,
    opacity 100ms ease;
}

.gs-tab:hover {
  opacity: 1;
  background: var(--brand-surface-bg-hover);
}

.gs-tab:focus-visible {
  outline: 2px solid var(--focus-ring, var(--neutral-50));
  outline-offset: -2px;
}

.gs-tab.active {
  opacity: 1;
  background: var(--brand-surface-bg-hover);
  color: var(--neutral-100);
}

.gs-pane {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.gs-github-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 4px;
}

.gs-github {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--neutral-100);
  opacity: 0.67;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 100ms ease;
}

.gs-github:hover,
.gs-github:focus-visible {
  opacity: 1;
  outline: none;
}

.gs-github-stars {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 14%, transparent);
  border-radius: 999px;
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
  color: var(--neutral-100);
  opacity: 0.78;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: opacity 100ms ease, background 100ms ease;
}

.gs-github-stars:hover,
.gs-github-stars:focus-visible {
  opacity: 1;
  background: color-mix(in oklab, var(--neutral-100) 8%, transparent);
  outline: none;
}

.gs-github-stars-icon {
  color: var(--warning, #e3b341);
  fill: currentColor;
}

.gs-subgroup {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gs-subgroup + .gs-subgroup {
  padding-top: 12px;
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}

.gs-subgroup-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: rgba(194, 191, 185, 0.75);
}

.gs-models {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gs-add-dir {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px dashed color-mix(in oklab, var(--neutral-100) 18%, transparent);
  background: transparent;
  border-radius: 8px;
  color: var(--neutral-100);
  cursor: pointer;
  align-self: flex-start;
  transition: background-color 100ms ease;
}

.gs-add-dir:hover,
.gs-add-dir:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.global-settings :deep(.settings-v2-field) {
  gap: 4px;
}

/* Density bump for the popup — slightly tighter input chrome than the
 * default `BaseInput` / `BaseSelect` so the two-pane card stays
 * compact. Label + field text colors come from the base components. */
.global-settings :deep(.ui-input),
.global-settings :deep(.ui-select-trigger) {
  min-height: 28px;
  border-radius: 6px;
}

.global-settings :deep(.ui-input-control),
.global-settings :deep(.ui-select-trigger) {
  font-size: 13px;
}

.global-settings :deep(.ui-input-trailing button) {
  width: 26px;
  height: 26px;
}
</style>
