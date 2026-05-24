<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings } from 'lucide-vue-next'
import ArgsRawInput from './ArgsRawInput.vue'
import type { ComfyArgDef, DetailField } from '../../types/ipc'

/**
 * Compact summary row for the `launchArgs` field. Shows the current
 * arg string with inline autocomplete and a gear icon that opens the
 * full `ArgsBuilderPage` sub-page.
 */

interface Props {
  field: DetailField
  installationId?: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  open: []
  update: [field: DetailField, value: string]
}>()

const { t } = useI18n()

const stringValue = computed(() => (props.field.value == null ? '' : String(props.field.value)))
const localValue = ref(stringValue.value)
watch(stringValue, (v) => {
  if (v !== localValue.value) localValue.value = v
})

const schema = ref<ComfyArgDef[]>([])

async function loadSchema(id: string | undefined): Promise<void> {
  if (!id) {
    schema.value = []
    return
  }
  try {
    const result = await window.api.getComfyArgs(id)
    schema.value = result?.args ?? []
  } catch {
    schema.value = []
  }
}

onMounted(() => void loadSchema(props.installationId))
watch(() => props.installationId, (id) => void loadSchema(id))

function handleEdit(): void {
  emit('open')
}

function handleInput(value: string): void {
  localValue.value = value
}

function handleChange(value: string): void {
  emit('update', props.field, value)
}
</script>

<template>
  <ArgsRawInput
    :model-value="localValue"
    :schema="schema"
    :placeholder="t('comfyUISettings.argsPlaceholder', 'No arguments set')"
    :aria-label="field.label"
    @update:model-value="handleInput"
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
  </ArgsRawInput>
</template>
