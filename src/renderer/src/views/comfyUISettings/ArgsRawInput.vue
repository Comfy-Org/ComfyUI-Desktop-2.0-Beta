<script setup lang="ts">
import { ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseInput from '../../components/ui/BaseInput.vue'
import { useArgsAutocomplete } from '../../composables/useArgsAutocomplete'
import type { ComfyArgDef } from '../../types/ipc'

/**
 * Raw startup-arguments text input with inline flag autocomplete.
 * Shared by the compact settings field and the full args sub-page.
 */

const props = withDefaults(
  defineProps<{
    modelValue: string
    schema: ComfyArgDef[]
    placeholder?: string
    ariaLabel?: string
    invalid?: boolean
  }>(),
  {
    placeholder: '',
    ariaLabel: undefined,
    invalid: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
  'focus-change': [focused: boolean]
}>()

const { t } = useI18n()

const localValue = ref(props.modelValue)
watch(
  () => props.modelValue,
  (next) => {
    if (next !== localValue.value) localValue.value = next
  },
)

const focused = ref(false)

const autocomplete = useArgsAutocomplete({
  value: localValue,
  schema: toRef(props, 'schema'),
  focused,
  onAccept(next) {
    localValue.value = next
    emit('update:modelValue', next)
    emit('change', next)
  },
})

function handleInput(value: string): void {
  localValue.value = value
  emit('update:modelValue', value)
}

function handleChange(value: string): void {
  emit('change', value)
}

function onFocus(): void {
  focused.value = true
  emit('focus-change', true)
}
function onBlur(): void {
  focused.value = false
  emit('focus-change', false)
}
function onKeydown(e: KeyboardEvent): void {
  if (autocomplete.handleKeydown(e.key) === 'consumed') e.preventDefault()
}
</script>

<template>
  <div
    class="args-raw-input"
    @focusin="onFocus"
    @focusout="onBlur"
    @keydown="onKeydown"
  >
    <BaseInput
      mono
      :model-value="localValue"
      :placeholder="placeholder || t('comfyUISettings.argsPlaceholder', 'No arguments set')"
      :aria-label="ariaLabel"
      :invalid="invalid"
      @update:model-value="handleInput"
      @change="handleChange"
    >
      <template v-if="$slots.trailing" #trailing>
        <slot name="trailing" />
      </template>
    </BaseInput>
    <ul
      v-if="autocomplete.visible.value"
      class="args-raw-input-ac"
      role="listbox"
      :aria-label="t('comfyUISettings.argsAutocompleteLabel', 'Argument suggestions')"
    >
      <li
        v-for="(m, i) in autocomplete.matches.value"
        :key="m.name"
        class="args-raw-input-ac-item"
        :class="{ selected: i === autocomplete.acIndex.value }"
        role="option"
        :aria-selected="i === autocomplete.acIndex.value"
        @mousedown.prevent="autocomplete.completeArg(m.name)"
        @mouseenter="autocomplete.acIndex.value = i"
      >
        <span class="args-raw-input-ac-flag">{{ m.flag }}</span>
        <span v-if="m.type !== 'boolean'" class="args-raw-input-ac-meta">
          {{ m.metavar ? (m.type === 'optional-value' ? `[${m.metavar}]` : m.metavar) : '' }}
        </span>
        <span class="args-raw-input-ac-help">{{ m.help }}</span>
      </li>
      <li class="args-raw-input-ac-hint" aria-hidden="true">
        {{ t('comfyUISettings.argsAutocompleteHint', '↑↓ navigate · Tab/Enter select · Esc dismiss') }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.args-raw-input {
  position: relative;
}

.args-raw-input-ac {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 50;
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  max-height: 280px;
  overflow-y: auto;
}

.args-raw-input-ac-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.args-raw-input-ac-item.selected,
.args-raw-input-ac-item:hover {
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
}

.args-raw-input-ac-flag {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-weight: 600;
  color: var(--accent-primary);
  flex-shrink: 0;
}

.args-raw-input-ac-meta {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.args-raw-input-ac-help {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.args-raw-input-ac-hint {
  padding: 4px 8px 2px;
  font-size: 10px;
  color: color-mix(in srgb, var(--text-muted) 70%, transparent);
  border-top: 1px solid var(--border);
  margin-top: 2px;
  text-align: right;
  cursor: default;
}
</style>
