<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsView from '../views/SettingsView.vue'
import DetailModal from '../views/DetailModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import type { ActionResult, Installation } from '../types/ipc'

export type PanelKey = 'install-settings' | 'launcher-settings'

const { setLocaleMessage, locale } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
const initialPanel = (params.get('panel') as PanelKey | null) || 'launcher-settings'

const activePanel = ref<PanelKey>(initialPanel)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)

const activeProgressId = ref<string | null>(null)

const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const launcherPrefs = useLauncherPrefs()

// installationStore.fetchInstallations() is wired to onInstallationsChanged
// inside the store itself, so the panel just needs to read from it.
const installation = computed<Installation | null>(
  () => (installationId ? installationStore.getById(installationId) ?? null : null),
)

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubSettings: (() => void) | null = null

async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  setLocaleMessage('en', messages)
  locale.value = 'en'
}

function handleShowProgress(opts: {
  installationId: string
  title: string
  apiCall: () => Promise<unknown>
  cancellable?: boolean
  returnTo?: string
}): void {
  activeProgressId.value = opts.installationId
  // If an in-progress operation already exists for this ID, just show it
  const existing = progressStore.operations.get(opts.installationId)
  if (existing && !existing.finished) {
    progressRef.value?.showOperation(opts.installationId)
    return
  }
  progressRef.value?.startOperation({
    installationId: opts.installationId,
    title: opts.title,
    apiCall: opts.apiCall as () => Promise<ActionResult>,
    cancellable: opts.cancellable,
    returnTo: opts.returnTo,
  })
}

function handleProgressClose(): void {
  activeProgressId.value = null
}

function handleUpdateInstallation(inst: Installation): void {
  // Optimistic local update for snappier UX while the broadcast-driven
  // refetch is in flight (e.g. rename via the editable title).
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
}

function handleNavigateList(): void {
  // The install was removed from the list (e.g. deleted, migrated). The
  // onInstallationsChanged broadcast wired into installationStore will refetch
  // automatically, after which `installation` becomes null and the panel
  // shows the missing-install placeholder. Nothing more to do here — the
  // parent ComfyUI window owns its own teardown.
}

onMounted(async () => {
  await loadLocale()

  unsubLocale = window.api.onLocaleChanged((messages) => {
    setLocaleMessage('en', messages as Record<string, unknown>)
  })

  // Main can request a panel switch (e.g. from title-bar buttons).
  unsubPanel = window.api.onPanelSwitch((data) => {
    if (data.panel === 'install-settings' || data.panel === 'launcher-settings') {
      activePanel.value = data.panel
    }
  })

  // Settings broadcast — refetch the launcher settings sections so panels
  // opened in multiple windows stay in sync.
  unsubSettings = window.api.onSettingsChanged(() => {
    settingsRef.value?.loadSettings()
  })

  // Initialize stores / prefs needed by the install-settings DetailModal.
  // installationStore wires its own onInstallationsChanged listener.
  await Promise.all([
    sessionStore.init(),
    installationStore.fetchInstallations(),
    launcherPrefs.loadPrefs(),
  ])
})

onUnmounted(() => {
  unsubPanel?.()
  unsubLocale?.()
  unsubSettings?.()
  sessionStore.dispose()
})
</script>

<template>
  <div class="panel-shell">
    <main class="panel-content">
      <SettingsView v-if="activePanel === 'launcher-settings'" ref="settingsRef" />

      <div v-else-if="activePanel === 'install-settings'" class="panel-install-settings">
        <DetailModal
          v-if="installation"
          :installation="installation"
          :inline="true"
          @show-progress="handleShowProgress"
          @navigate-list="handleNavigateList"
          @update:installation="handleUpdateInstallation"
        />
        <div v-else class="panel-placeholder">
          <p v-if="installationStore.loading">{{ $t('common.loading') }}</p>
          <p v-else>
            {{ $t('titleBar.installationLabel') }}:
            <code>{{ installationId }}</code>
          </p>
        </div>
      </div>
    </main>

    <!-- Progress overlay for actions kicked off from the install-settings panel. -->
    <div v-show="activeProgressId" class="view-modal active" data-overlay-key="progress">
      <ProgressModal
        ref="progressRef"
        :installation-id="activeProgressId"
        @close="handleProgressClose"
      />
    </div>

    <ModalDialog />
  </div>
</template>

<style scoped>
.panel-shell {
  /* The panel WebContentsView lives BELOW the ComfyUI window's title bar
   * (which is its own WebContentsView). The panel renderer therefore has no
   * title bar of its own — neutralize the global --titlebar-height inset so
   * overlay modals (ProgressModal etc.) span the full panel area. */
  --titlebar-height: 0px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

.panel-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* Match the launcher window's `.content` padding so tab-mode views
   * (SettingsView etc.) have the same gutter as in the standalone window. */
  padding: 24px 28px;
  overflow: hidden;
}

/* Install-settings hosts an inline DetailModal that owns its own padding,
 * so we negate the panel-content gutter for that branch only. */
.panel-content:has(.panel-install-settings) {
  padding: 0;
}

.panel-install-settings {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-placeholder {
  padding: 24px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.6;
}

.panel-placeholder code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
