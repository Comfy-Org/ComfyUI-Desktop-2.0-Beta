<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSections from '../components/SettingsSections.vue'
import ModalShell from '../components/ModalShell.vue'
import { useModal } from '../composables/useModal'
import type { SettingsSection, SettingsAction } from '../types/ipc'

const { t } = useI18n()
const modal = useModal()

const emit = defineEmits<{ close: [] }>()

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

onMounted(() => loadSettings())

defineExpose({ loadSettings })
</script>

<template>
  <ModalShell :title="t('settings.title')" @close="emit('close')">
    <SettingsSections
      :sections="sections"
      :checking-for-updates="checkingForUpdates"
      @setting-updated="loadSettings"
      @action="handleAction"
    />
  </ModalShell>
</template>
