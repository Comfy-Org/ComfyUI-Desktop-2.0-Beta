<script setup lang="ts">
import SettingField from './SettingField.vue'
import type { SettingsSection, SettingsAction } from '../types/ipc'

defineProps<{
  sections: SettingsSection[]
  checkingForUpdates: boolean
}>()

const emit = defineEmits<{
  settingUpdated: []
  action: [action: SettingsAction]
}>()
</script>

<template>
  <div
    v-for="(section, sIdx) in sections"
    :key="sIdx"
    class="settings-section"
  >
    <div v-if="section.title" class="detail-section-title">{{ section.title }}</div>
    <div class="detail-fields">
      <SettingField
        v-for="field in section.fields"
        :key="field.id"
        :field="field"
        @setting-updated="emit('settingUpdated')"
      />
    </div>
    <div v-if="section.actions?.length" class="detail-actions">
      <button
        v-for="(action, aIdx) in section.actions"
        :key="aIdx"
        :disabled="action.action === 'check-for-update' && checkingForUpdates"
        @click="emit('action', action)"
      >
        {{ action.action === 'check-for-update' && checkingForUpdates ? $t('settings.checkingForUpdates') : action.label }}
      </button>
    </div>
  </div>
</template>
