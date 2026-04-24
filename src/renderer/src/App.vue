<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from './stores/sessionStore'
import { useInstallationStore } from './stores/installationStore'
import { useProgressStore } from './stores/progressStore'
import { useDownloadStore } from './stores/downloadStore'
import { useModal } from './composables/useModal'
import { useTheme } from './composables/useTheme'
import { useLauncherPrefs } from './composables/useLauncherPrefs'
import { useNavigation } from './composables/useNavigation'
import type { Installation, ActionResult, QuitActiveItem } from './types/ipc'
import type { ModalDetailGroup } from './composables/useModal'
import { emitTelemetryAction } from './lib/telemetry'

import ModalDialog from './components/ModalDialog.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import ZoomBanner from './components/ZoomBanner.vue'
import ViewShell from './components/ViewShell.vue'
import DashboardView from './views/DashboardView.vue'
import InstallationList from './views/InstallationList.vue'
import RunningView from './views/RunningView.vue'
import SettingsView from './views/SettingsView.vue'
import ModelsView from './views/ModelsView.vue'
import MediaView from './views/MediaView.vue'
import TitleBar from './components/TitleBar.vue'

// Lucide icons
import { LayoutDashboard, Box, Play, FolderOpen, Image, Settings, MessageSquarePlus } from 'lucide-vue-next'
import { buildSupportUrl } from './lib/supportUrl'

const { t, setLocaleMessage, locale } = useI18n()
const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const downloadStore = useDownloadStore()
const modal = useModal()
const launcherPrefs = useLauncherPrefs()
const nav = useNavigation()
useTheme()

// --- View state ---
type TabView = 'dashboard' | 'list' | 'running' | 'models' | 'media' | 'settings'
const activeView = nav.activeTab
const appVersion = ref('')

// --- Template refs ---
const listRef = ref<InstanceType<typeof InstallationList> | null>(null)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const modelsRef = ref<InstanceType<typeof ModelsView> | null>(null)
const mediaRef = ref<InstanceType<typeof MediaView> | null>(null)

// --- Sidebar ---
const sidebarItems = computed(() => [
  { key: 'dashboard' as const, icon: LayoutDashboard, labelKey: 'dashboard.title' },
  { key: 'list' as const, icon: Box, labelKey: 'sidebar.installations' },
  { key: 'running' as const, icon: Play, labelKey: 'sidebar.running' },
  { key: 'models' as const, icon: FolderOpen, labelKey: 'models.title' },
  { key: 'media' as const, icon: Image, labelKey: 'media.title' },
  { key: 'settings' as const, icon: Settings, labelKey: 'settings.title' },
])

function switchView(view: TabView): void {
  const fromView = activeView.value
  nav.switchTab(view)
  if (view !== fromView) {
    emitTelemetryAction('launcher.view.opened', {
      view,
      from_view: fromView,
    })
  }
  if (view === 'list') listRef.value?.refresh()
  else if (view === 'settings') settingsRef.value?.loadSettings()
  else if (view === 'models') modelsRef.value?.loadModels()
  else if (view === 'media') mediaRef.value?.loadMedia()
}

function openFeedback(): void {
  emitTelemetryAction('launcher.feedback.opened')
  window.api.openExternal(buildSupportUrl(appVersion.value || undefined))
}

// --- Modal handlers ---
function openDetail(inst: Installation, tab?: string, autoAction?: string): void {
  nav.present('detail', {
    installation: inst,
    initialTab: tab ?? 'status',
    autoAction: autoAction ?? null,
  })
}

function openConsole(installationId: string): void {
  nav.present('console', { installationId })
}

async function openNewInstall(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'new_install',
    entrypoint: activeView.value,
  })
  nav.present('new-install', {})
  await nav.invokeWhenReady('new-install', (c) => c.open())
}

async function openQuickInstall(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'quick_install',
    entrypoint: activeView.value,
  })
  nav.present('quick-install', {})
  await nav.invokeWhenReady('quick-install', (c) => c.open())
}

async function openTrack(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'track_existing',
    entrypoint: activeView.value,
  })
  nav.present('track', {})
  await nav.invokeWhenReady('track', (c) => c.open())
}

async function openLoadSnapshot(): Promise<void> {
  emitTelemetryAction('launcher.install.flow.opened', {
    flow: 'load_snapshot',
    entrypoint: activeView.value,
  })
  nav.present('load-snapshot', {})
  await nav.invokeWhenReady('load-snapshot', (c) => c.open())
}

function showProgress(opts: {
  installationId: string
  title: string
  apiCall: () => Promise<unknown>
  cancellable?: boolean
  returnTo?: string
}): void {
  // Close any open modal so they don't stack visually
  if (opts.returnTo === 'detail') nav.dismiss('detail')
  nav.present('progress', { installationId: opts.installationId })
  // If an in-progress operation already exists for this ID, just show it
  const existingOp = progressStore.operations.get(opts.installationId)
  if (existingOp && !existingOp.finished) {
    nav.invokeWhenReady('progress', (c) => c.showOperation(opts.installationId))
    return
  }
  nav.invokeWhenReady('progress', (c) => c.startOperation({
    installationId: opts.installationId,
    title: opts.title,
    apiCall: opts.apiCall as () => Promise<ActionResult>,
    cancellable: opts.cancellable,
    returnTo: opts.returnTo,
  }))
}

function handleNavigateList(): void {
  nav.dismiss('detail')
  listRef.value?.refresh()
}

function handleProgressShowDetail(installationId: string): void {
  nav.dismiss('progress')
  const inst = installationStore.getById(installationId)
  if (inst) openDetail(inst)
}

function handleOverlayClosed(key: string): void {
  if (key === 'progress') listRef.value?.refresh()
}

// --- Quit confirmation ---
function buildQuitDetails(details: QuitActiveItem[]): ModalDetailGroup[] {
  const groups: { label: string; type: QuitActiveItem['type'] }[] = [
    { label: t('settings.closeQuitSessions'), type: 'session' },
    { label: t('settings.closeQuitOperations'), type: 'operation' },
    { label: t('settings.closeQuitDownloads'), type: 'download' },
  ]
  return groups
    .map(({ label, type }) => ({ label, items: details.filter((d) => d.type === type).map((d) => d.name) }))
    .filter((g) => g.items.length > 0)
}

function setupQuitConfirmation(): void {
  window.api.onConfirmQuit(async (details) => {
    const confirmed = await modal.confirm({
      title: t('settings.closeQuitTitle'),
      message: t('settings.closeQuitMessage'),
      messageDetails: buildQuitDetails(details),
      confirmLabel: t('settings.closeQuitConfirm'),
      confirmStyle: 'danger',
    })
    if (confirmed) window.api.quitApp()
  })
}

// --- Locale ---
async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  setLocaleMessage('en', messages)
  locale.value = 'en'
}

function setupLocaleListener(): void {
  window.api.onLocaleChanged((messages) => {
    setLocaleMessage('en', messages)
  })
}

function setupChineseMirrorsSuggestion(): void {
  window.api.onSuggestChineseMirrors(async () => {
    const confirmed = await modal.confirm({
      title: t('settings.chineseMirrorsSuggestTitle'),
      message: t('settings.chineseMirrorsSuggestMessage'),
      confirmLabel: t('settings.chineseMirrorsSuggestConfirm'),
    })
    if (confirmed) {
      await window.api.setSetting('useChineseMirrors', true)
    }
    await window.api.setSetting('chineseMirrorsPrompted', true)
  })
}

// --- Init ---
onMounted(async () => {
  await loadLocale()
  await sessionStore.init()
  downloadStore.init()
  launcherPrefs.loadPrefs()
  setupQuitConfirmation()
  setupLocaleListener()
  setupChineseMirrorsSuggestion()
  listRef.value?.refresh()
  appVersion.value = await window.api.getAppVersion()
})
</script>

<template>
  <TitleBar />
  <div class="app-layout">
    <!-- Sidebar -->
    <nav class="sidebar">
      <div class="sidebar-brand">Desktop 2.0</div>
      <div class="sidebar-nav">
        <button
          v-for="item in sidebarItems"
          :key="item.key"
          class="sidebar-item"
          :class="{ active: activeView === item.key }"
          @click="switchView(item.key)"
        >
          <component :is="item.icon" :size="18" />
          <span>{{ $t(item.labelKey) }}</span>
          <template v-if="item.key === 'running'">
            <span
              v-if="sessionStore.hasErrors"
              class="sidebar-error-dot"
            ></span>
            <span
              v-if="sessionStore.runningTabCount > 0"
              class="sidebar-count"
            >{{ sessionStore.runningTabCount }}</span>
          </template>
          <template v-if="item.key === 'models'">
            <span
              v-if="downloadStore.activeDownloads.length > 0"
              class="sidebar-count"
            >{{ downloadStore.activeDownloads.length }}</span>
          </template>
        </button>
      </div>
      <button class="sidebar-item sidebar-feedback" @click="openFeedback">
        <MessageSquarePlus :size="18" />
        <span>{{ $t('sidebar.giveFeedback') }}</span>
      </button>
      <div v-if="appVersion" class="sidebar-version">v{{ appVersion }}</div>
    </nav>

    <!-- Content Area -->
    <main class="content">
      <UpdateBanner />
      <ZoomBanner />
      <DashboardView
        v-show="activeView === 'dashboard'"
        :visible="activeView === 'dashboard'"
        @show-quick-install="openQuickInstall"
        @show-settings="switchView('settings')"
        @show-detail="(inst, tab, autoAction) => openDetail(inst, tab, autoAction)"
        @show-console="openConsole"
        @show-progress="showProgress"
      />

      <InstallationList
        v-show="activeView === 'list'"
        ref="listRef"
        @show-detail="(inst, tab) => openDetail(inst, tab)"
        @show-migrate="(inst) => openDetail(inst, undefined, 'migrate-to-standalone')"
        @show-console="openConsole"
        @show-progress="showProgress"
        @show-new-install="openNewInstall"
        @show-track="openTrack"
        @show-load-snapshot="openLoadSnapshot"
      />

      <RunningView
        v-show="activeView === 'running'"
        @show-detail="openDetail"
        @show-console="openConsole"
        @show-progress="showProgress"
      />

      <ModelsView
        v-show="activeView === 'models'"
        ref="modelsRef"
      />

      <MediaView
        v-show="activeView === 'media'"
        ref="mediaRef"
      />

      <SettingsView
        v-show="activeView === 'settings'"
        ref="settingsRef"
      />
    </main>
  </div>

  <!-- Modal views (rendered by ViewShell from navigation overlay stack) -->
  <ViewShell
    @show-progress="showProgress"
    @show-detail="handleProgressShowDetail"
    @show-console="openConsole"
    @navigate-list="handleNavigateList"
    @update:installation="(inst) => { nav.patchOverlay('detail', { installation: inst }); installationStore.fetchInstallations() }"
    @overlay-closed="handleOverlayClosed"
  />

  <!-- Global modal dialog (alerts/confirms/prompts/selects) -->
  <ModalDialog />
</template>
