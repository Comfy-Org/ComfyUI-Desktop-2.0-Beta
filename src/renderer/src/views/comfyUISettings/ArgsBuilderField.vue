<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import type { DetailField } from '../../types/ipc'

/**
 * Compact summary row for the `launchArgs` field. Shows the current
 * arg string (or a placeholder when empty) with an inline gear icon
 * docked on the input's right edge that opens the `ArgsBuilderPage`
 * sub-page.
 *
 * The 400px drawer can't fit a categorized flag editor inline, and an
 * anchored popover would clip at the drawer edge. The sub-page slide
 * takes over the drawer body while editing — same convention macOS
 * System Settings + iOS Settings use for deep configuration screens.
 */

interface Props {
  field: DetailField
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** Parent should swap drawer body to the args sub-page. */
  open: []
  /** Live edit of the raw text — same emit shape as PathField / EnvVarsField
   *  so the parent's dispatch can route them through `updateField`. */
  update: [field: DetailField, value: string]
}>()

const { t } = useI18n()

const stringValue = computed(() => (props.field.value == null ? '' : String(props.field.value)))

function handleEdit(): void {
  emit('open')
}

function handleChange(value: string): void {
  emit('update', props.field, value)
}
</script>

<template>
  <BaseInput
    mono
    :model-value="stringValue"
    :placeholder="t('comfyUISettings.argsPlaceholder', 'No arguments set')"
    :aria-label="field.label"
    @change="handleChange"
  >
    <template #trailing>
      <button
        type="button"
        :aria-label="t('comfyUISettings.configureArgs', 'Configure arguments')"
        @click="handleEdit"
      >
        <Settings :size="14" />
      </button>
    </template>
  </BaseInput>
</template>
