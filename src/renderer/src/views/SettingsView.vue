<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSections from '../components/SettingsSections.vue'
import { useModal } from '../composables/useModal'
import type { SettingsSection, SettingsAction } from '../types/ipc'

/**
 * Bare global-settings panel body. Mounted inside the unified
 * SettingsModal as the "Global Settings" tab. Owns its own data
 * fetch + setting-action handling but no chrome — the parent
 * supplies the ModalShell and close button.
 */

const { t } = useI18n()
const modal = useModal()

function openUrl(url: string): void {
  window.api.openExternal(url)
}

const sections = ref<SettingsSection[]>([])
const checkingForUpdates = ref(false)
const systemManaged = ref(false)

async function loadSettings(): Promise<void> {
  sections.value = await window.api.getSettingsSections()
  const caps = await window.api.getUpdateCapabilities()
  systemManaged.value = caps.systemManaged
}

async function handleAction(action: SettingsAction): Promise<void> {
  if (action.url) {
    openUrl(action.url)
    return
  }
  if (action.action === 'check-for-update') {
    checkingForUpdates.value = true
    try {
      const result = await window.api.checkForUpdate()
      if (!result.available && !result.error) {
        const message = systemManaged.value ? t('update.debUpToDate') : t('update.upToDate')
        await modal.alert({ title: t('update.updateCheck'), message })
      } else if (result.error) {
        await modal.alert({ title: t('update.updateError'), message: result.error })
      }
    } finally {
      checkingForUpdates.value = false
    }
  }
}

// Refetch when main broadcasts a settings change so panels opened
// in multiple windows stay in sync. The cleanup runs on unmount
// (e.g. when the user switches sidebar tabs in the parent modal).
let unsubSettingsChanged: (() => void) | null = null

onMounted(() => {
  void loadSettings()
  unsubSettingsChanged = window.api.onSettingsChanged(() => {
    void loadSettings()
  })
})

onUnmounted(() => {
  unsubSettingsChanged?.()
})

defineExpose({ loadSettings })
</script>

<template>
  <SettingsSections
    :sections="sections"
    :checking-for-updates="checkingForUpdates"
    @setting-updated="loadSettings"
    @action="handleAction"
  />
</template>
