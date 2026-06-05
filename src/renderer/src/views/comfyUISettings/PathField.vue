<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderOpen } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import type { DetailField } from '../../types/ipc'

/**
 * Path field for the Settings drawer. `field.browseOnly === true` makes the input read-only so the value is only changed via Browse.
 */

interface Props {
  field: DetailField
}

const props = defineProps<Props>()

const emit = defineEmits<{
  update: [field: DetailField, value: string]
}>()

const { t } = useI18n()

const stringValue = computed(() => (props.field.value == null ? '' : String(props.field.value)))
const isBrowseOnly = computed(() => props.field.browseOnly === true)

async function handleBrowse(): Promise<void> {
  const dir = await window.api.browseFolder(stringValue.value || undefined)
  if (dir) emit('update', props.field, dir)
}

function handleChange(value: string): void {
  if (isBrowseOnly.value) return
  emit('update', props.field, value)
}
</script>

<template>
  <BaseInput
    :model-value="stringValue"
    :readonly="isBrowseOnly"
    :aria-label="field.label || undefined"
    @change="handleChange"
  >
    <template #trailing>
      <button
        type="button"
        :aria-label="t('common.browse', 'Browse')"
        @click="handleBrowse"
      >
        <FolderOpen :size="14" />
      </button>
    </template>
  </BaseInput>
</template>
