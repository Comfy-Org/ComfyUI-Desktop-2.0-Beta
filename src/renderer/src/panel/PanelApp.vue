<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsView from '../views/SettingsView.vue'
import ModalDialog from '../components/ModalDialog.vue'
import { useTheme } from '../composables/useTheme'

export type PanelKey = 'install-settings' | 'launcher-settings'

const { setLocaleMessage, locale } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
const initialPanel = (params.get('panel') as PanelKey | null) || 'launcher-settings'

const activePanel = ref<PanelKey>(initialPanel)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)

const titleKey = computed(() =>
  activePanel.value === 'install-settings' ? 'titleBar.panelInstallSettings' : 'titleBar.panelLauncherSettings'
)

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubSettings: (() => void) | null = null

async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  setLocaleMessage('en', messages)
  locale.value = 'en'
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
})

onUnmounted(() => {
  unsubPanel?.()
  unsubLocale?.()
  unsubSettings?.()
})
</script>

<template>
  <div class="panel-shell">
    <main class="panel-content">
      <SettingsView v-if="activePanel === 'launcher-settings'" ref="settingsRef" />

      <div v-else-if="activePanel === 'install-settings'" class="view active">
        <div class="toolbar">
          <div class="breadcrumb">
            <span class="breadcrumb-current">{{ $t(titleKey) }}</span>
          </div>
        </div>
        <div class="view-scroll">
          <div class="panel-placeholder">
            <p>{{ $t('titleBar.installSettingsComingSoon') }}</p>
            <p v-if="installationId" class="panel-placeholder-sub">
              {{ $t('titleBar.installationLabel') }}:
              <code>{{ installationId }}</code>
            </p>
          </div>
        </div>
      </div>
    </main>

    <ModalDialog />
  </div>
</template>

<style scoped>
.panel-shell {
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
}

.panel-placeholder {
  padding: 24px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.6;
}

.panel-placeholder-sub {
  margin-top: 12px;
  font-size: 12px;
}

.panel-placeholder code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
