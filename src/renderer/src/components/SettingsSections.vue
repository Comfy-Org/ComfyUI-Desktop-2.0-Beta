<script setup lang="ts">
// TODO(brand-cleanup): Used only by the legacy SettingsView.vue, which
// itself is slated to be replaced by the picker-style Global Settings
// popup. Safe to delete together with SettingsView once the new popup
// ships parity. See docs/global-settings-handoff.md.
import SettingField from './SettingField.vue'
import type { SettingsSection, SettingsAction } from '../types/ipc'

defineProps<{
  sections: SettingsSection[]
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
        @click="emit('action', action)"
      >
        {{ action.label }}
      </button>
    </div>
  </div>
</template>
