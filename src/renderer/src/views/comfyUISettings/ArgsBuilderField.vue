<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings2 } from 'lucide-vue-next'
import type { DetailField } from '../../types/ipc'

/**
 * Compact summary row for the `launchArgs` field. Shows the current
 * arg string (or a placeholder when empty) plus a gear button that
 * tells the drawer parent to open the `ArgsBuilderPage` sub-page.
 *
 * UX rationale (per user direction "think as UX designer"): a 400px
 * drawer can't fit a categorized flag editor inline, and an anchored
 * popover would clip at the drawer edge. The sub-page slide takes
 * over the drawer body while editing — same convention macOS System
 * Settings + iOS Settings use for deep configuration screens.
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
const isEmpty = computed(() => stringValue.value.trim().length === 0)

function handleEdit(): void {
  emit('open')
}

function handleTextChange(event: Event): void {
  emit('update', props.field, (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="args-field">
    <input
      type="text"
      class="args-field-input"
      :class="{ 'is-empty': isEmpty }"
      :value="stringValue"
      :placeholder="t('comfyUISettings.argsPlaceholder', 'No arguments set')"
      :aria-label="field.label"
      @change="handleTextChange"
    />
    <button
      type="button"
      class="args-field-edit"
      :aria-label="t('comfyUISettings.configureArgs', 'Configure arguments')"
      @click="handleEdit"
    >
      <Settings2 :size="14" />
      <span>{{ t('common.configure', 'Configure') }}</span>
    </button>
  </div>
</template>

<style scoped>
.args-field {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.args-field-input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
}

.args-field-input.is-empty {
  font-family: inherit;
  font-size: 13px;
  color: var(--text-muted);
}

.args-field-input:focus {
  outline: none;
  border-color: var(--accent);
}

.args-field-edit {
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

.args-field-edit:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border-color: var(--border-hover);
}

.args-field-edit:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
