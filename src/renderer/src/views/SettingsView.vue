<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsSections from '../components/SettingsSections.vue'
import { useModal } from '../composables/useModal'
import type { NavigationMode } from '../composables/useNavigation'
import type { SettingsSection, SettingsAction } from '../types/ipc'

interface Props {
  mode?: NavigationMode
}

withDefaults(defineProps<Props>(), {
  mode: undefined,
})

const emit = defineEmits<{
  close: []
}>()

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

onMounted(() => loadSettings())

defineExpose({ loadSettings })
</script>

<template>
  <!-- Overlay mode: render inside view-modal-content with header/close -->
  <div v-if="mode" class="view-modal-content">
    <div class="view-modal-header">
      <div class="view-modal-title">{{ $t('settings.title') }}</div>
      <button class="view-modal-close" @click="emit('close')">✕</button>
    </div>
    <div class="view-modal-body">
      <div class="view-scroll">
        <SettingsSections
          :sections="sections"
          :checking-for-updates="checkingForUpdates"
          @setting-updated="loadSettings"
          @action="handleAction"
        />
      </div>
    </div>
  </div>

  <!-- Tab mode: original inline layout -->
  <div v-else class="view active">
    <div class="toolbar">
      <div class="breadcrumb">
        <span class="breadcrumb-current">{{ $t('settings.title') }}</span>
      </div>
    </div>
    <div class="view-scroll">
      <SettingsSections
        :sections="sections"
        :checking-for-updates="checkingForUpdates"
        @setting-updated="loadSettings"
        @action="handleAction"
      />
    </div>
  </div>
</template>
