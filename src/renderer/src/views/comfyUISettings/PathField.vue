<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderOpen } from 'lucide-vue-next'
import type { DetailField } from '../../types/ipc'

/**
 * Path field for the brand-redesigned Settings drawer (v2). Mirrors
 * the legacy `DetailSection.vue`'s `editType === 'path'` branch in
 * functionality but in the drawer's design language.
 *
 * `field.browseOnly === true` → the text input is read-only and the
 * user can only change the value via the Browse button (matches the
 * legacy behavior for paths where typing would be error-prone).
 *
 * The component is presentational; the parent owns the `updateField`
 * call so the same path goes through the composable's IPC + reload.
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

function handleTextChange(event: Event): void {
  if (isBrowseOnly.value) return
  const value = (event.target as HTMLInputElement).value
  emit('update', props.field, value)
}
</script>

<template>
  <div class="path-field">
    <input
      type="text"
      class="path-field-input"
      :class="{ 'is-readonly': isBrowseOnly }"
      :value="stringValue"
      :readonly="isBrowseOnly"
      :aria-label="field.label"
      @change="handleTextChange"
    />
    <button
      type="button"
      class="path-field-browse"
      :aria-label="t('common.browse', 'Browse')"
      @click="handleBrowse"
    >
      <FolderOpen :size="14" />
      <span>{{ t('common.browse', 'Browse') }}</span>
    </button>
  </div>
</template>

<style scoped>
.path-field {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.path-field-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.path-field-input:focus {
  outline: none;
  border-color: var(--accent);
}

.path-field-input.is-readonly {
  color: var(--text-muted);
  cursor: default;
}

.path-field-browse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.path-field-browse:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border-color: var(--border-hover);
}

.path-field-browse:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
