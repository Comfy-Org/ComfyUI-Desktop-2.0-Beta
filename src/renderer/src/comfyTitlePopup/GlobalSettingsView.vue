<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { HardDrive, RefreshCcw, Settings2, SlidersHorizontal, X } from 'lucide-vue-next'
import UpdatesSection from './globalSettings/UpdatesSection.vue'
import GlobalSettingsMicroSection from './globalSettings/GlobalSettingsMicroSection.vue'
import GlobalStorageSections from './globalSettings/GlobalStorageSections.vue'
import GitHubLinkCard from './globalSettings/GitHubLinkCard.vue'
import SettingsSectionList from '../views/comfyUISettings/SettingsSectionList.vue'
import { withMinDuration } from '../lib/uiTiming'
import type {
  AppUpdateDownloadProgress,
  AppUpdateState,
  DetailField,
  DetailSection
} from '../types/ipc'

/**
 * Global Settings popup view — two-pane tabbed card (desktop-only).
 *
 * Receives a `snapshot` prop built main-side by `buildGlobalSettingsSnapshot`
 * in `src/main/popups/titlePopup.ts` and dispatches mutations through
 * `window.__comfyTitlePopup`.
 */

interface ModelsDir {
  path: string
  isPrimary: boolean
  isDefault: boolean
}

interface Snapshot {
  generalFields: Record<string, unknown>[]
  telemetryFields: Record<string, unknown>[]
  desktopUpdateFields: Record<string, unknown>[]
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
  githubUrl: string
  githubStars: number | null
  i18n: {
    overview: string
    updates: string
    storage: string
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
}

const props = defineProps<{ snapshot: Snapshot }>()
const { t } = useI18n()
const bridge = (window as unknown as { __comfyTitlePopup?: GlobalSettingsBridge }).__comfyTitlePopup

const LAST_CHECKED_KEY = 'globalSettings.lastCheckedAt'

type TabId = 'general' | 'updates' | 'storage' | 'advanced'
const activeTab = ref<TabId>('general')

const tabs = computed(() => [
  { id: 'general' as const, label: props.snapshot.i18n.overview, icon: Settings2 },
  { id: 'updates' as const, label: props.snapshot.i18n.updates, icon: RefreshCcw },
  { id: 'storage' as const, label: props.snapshot.i18n.storage, icon: HardDrive },
  { id: 'advanced' as const, label: props.snapshot.i18n.advanced, icon: SlidersHorizontal }
])

const storageSnapshot = computed(() => ({
  sharedDirectoriesFields: props.snapshot.sharedDirectoriesFields,
  modelsDirs: props.snapshot.modelsDirs,
  modelsSystemDefault: props.snapshot.modelsSystemDefault,
}))

const generalSections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.generalFields as unknown as DetailField[] }
])
const telemetrySections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.telemetryFields as unknown as DetailField[] }
])
const desktopUpdatePreferenceFields = computed<DetailField[]>(
  () => props.snapshot.desktopUpdateFields as unknown as DetailField[]
)
const cacheSections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.cacheFields as unknown as DetailField[] }
])
const advancedSections = computed<DetailSection[]>(() => [
  { fields: props.snapshot.advancedFields as unknown as DetailField[] }
])
const appUpdateState = computed<AppUpdateState>(
  () => props.snapshot.appUpdate.state as unknown as AppUpdateState
)
const appUpdateProgress = computed<AppUpdateDownloadProgress | null>(
  () => props.snapshot.appUpdate.progress as unknown as AppUpdateDownloadProgress | null
)

async function handleUpdateField(field: DetailField, value: unknown): Promise<void> {
  await bridge?.globalSettingsUpdateField(field.id, value)
}

function handleOpenExternal(url: string): void {
  if (!url) return
  bridge?.globalSettingsOpenExternal(url)
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

const isChecking = ref(false)

async function handleCheckForUpdate(): Promise<void> {
  isChecking.value = true
  try {
    // `withMinDuration` floors the busy state so a sub-frame backend
    // response (e.g. dev-mode no-op, up-to-date short-circuit) still
    // flashes the "Checking…" label long enough to feel acknowledged.
    await withMinDuration(async () => {
      await bridge?.globalSettingsCheckForUpdate()
    })
  } finally {
    const now = Date.now()
    try {
      window.localStorage.setItem(LAST_CHECKED_KEY, String(now))
    } catch {
      /* noop */
    }
    bridge?.globalSettingsSetLastCheckedAt(now)
    isChecking.value = false
  }
}

function handleTabKey(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  const ids = tabs.value.map((tab) => tab.id)
  const idx = ids.indexOf(activeTab.value)
  const next =
    event.key === 'ArrowDown' ? (idx + 1) % ids.length : (idx - 1 + ids.length) % ids.length
  activeTab.value = ids[next] as TabId
}

onMounted(() => {
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
          <GlobalSettingsMicroSection :title="t('settings.preferences', 'Preferences')">
            <SettingsSectionList :sections="generalSections" @update-field="handleUpdateField" />
          </GlobalSettingsMicroSection>

          <GlobalSettingsMicroSection :title="t('settings.privacy', 'Privacy')">
            <SettingsSectionList :sections="telemetrySections" @update-field="handleUpdateField" />
          </GlobalSettingsMicroSection>

          <GlobalSettingsMicroSection :title="t('settings.community', 'Community')">
            <GitHubLinkCard
              :url="snapshot.githubUrl"
              :stars="snapshot.githubStars"
              @open="handleOpenExternal"
            />
          </GlobalSettingsMicroSection>
        </template>

        <template v-else-if="activeTab === 'updates'">
          <UpdatesSection
            :state="appUpdateState"
            :progress="appUpdateProgress"
            :is-downloading="snapshot.appUpdate.isDownloading"
            :checking="isChecking"
            :last-checked-at="snapshot.appUpdate.lastCheckedAt"
            :installed-version="snapshot.appUpdate.installedVersion"
            :system-managed="snapshot.appUpdate.capabilities.systemManaged"
            :preference-fields="desktopUpdatePreferenceFields"
            @update-now="handleUpdateNow"
            @check-for-update="handleCheckForUpdate"
            @update-field="handleUpdateField"
          />
        </template>

        <template v-else-if="activeTab === 'storage'">
          <GlobalStorageSections :snapshot="storageSnapshot" />
        </template>

        <template v-else>
          <GlobalSettingsMicroSection :title="snapshot.i18n.advanced">
            <SettingsSectionList :sections="advancedSections" @update-field="handleUpdateField" />
          </GlobalSettingsMicroSection>

          <GlobalSettingsMicroSection :title="t('settings.cache', 'Cache')">
            <SettingsSectionList :sections="cacheSections" @update-field="handleUpdateField" />
          </GlobalSettingsMicroSection>
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
  gap: 20px;
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

.global-settings :deep(.ui-input-trailing button) {
  width: 26px;
  height: 26px;
}
</style>
