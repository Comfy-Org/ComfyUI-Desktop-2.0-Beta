<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsView from '../views/SettingsView.vue'
import DetailModal from '../views/DetailModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import type { ActionResult, Installation } from '../types/ipc'

/**
 * Body modes the panel WebContentsView can render. Mirrors the `BodyMode`
 * union in `src/main/index.ts` — `'comfy-lifecycle'` is the lifecycle UI
 * shown for the Comfy tab when no ComfyUI process is running, the others
 * are the title-bar pills that map directly to a panel.
 */
export type PanelKey = 'comfy-lifecycle' | 'install-settings' | 'launcher-settings'

const VALID_PANELS: ReadonlySet<PanelKey> = new Set([
  'comfy-lifecycle',
  'install-settings',
  'launcher-settings',
])

const { setLocaleMessage, locale } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
const initialPanel: PanelKey = ((): PanelKey => {
  const raw = params.get('panel')
  return raw && VALID_PANELS.has(raw as PanelKey) ? (raw as PanelKey) : 'launcher-settings'
})()

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
  // ComfyUI window that hosts this panel no longer has an install backing
  // it, so ask main to close the parent window. Falls back to the
  // missing-install placeholder if the close fails for any reason
  // (e.g. window already torn down) — the onInstallationsChanged broadcast
  // wired into installationStore has already cleared the local record.
  if (installationId) {
    void window.api.closeComfyWindow(installationId)
  }
}

onMounted(async () => {
  await loadLocale()

  unsubLocale = window.api.onLocaleChanged((messages) => {
    setLocaleMessage('en', messages as Record<string, unknown>)
  })

  // Main can request a panel switch (e.g. from title-bar buttons, or when
  // the install lifecycle changes — main flips us to 'comfy-lifecycle' when
  // the instance stops so the Comfy tab body shows the right transient UI).
  unsubPanel = window.api.onPanelSwitch((data) => {
    if (VALID_PANELS.has(data.panel as PanelKey)) {
      activePanel.value = data.panel as PanelKey
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

      <div v-else-if="activePanel === 'comfy-lifecycle'" class="panel-comfy-lifecycle">
        <ComfyLifecycleView
          :installation="installation"
          :installation-id="installationId"
          @show-progress="handleShowProgress"
        />
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

/* Install-settings hosts an inline DetailModal and the comfy-lifecycle view
 * fills its own background — both own their padding, so negate the
 * panel-content gutter for those branches. */
.panel-content:has(.panel-install-settings),
.panel-content:has(.panel-comfy-lifecycle) {
  padding: 0;
}

/* The tab-mode SettingsView renders a `.toolbar` breadcrumb ("Settings") at
 * the top to show "you are here" inside the launcher window. The panel's
 * title bar already labels the active panel ("Launcher Settings"), so the
 * breadcrumb is redundant — hide it inside the panel only. */
.panel-content :deep(.view.active > .toolbar) {
  display: none;
}

.panel-install-settings,
.panel-comfy-lifecycle {
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
