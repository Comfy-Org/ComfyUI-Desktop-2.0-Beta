<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import { useArgsAutocomplete } from '../../composables/useArgsAutocomplete'
import { validateArgs } from '../../lib/argsParser'
import type { ComfyArgDef } from '../../types/ipc'

/**
 * Raw startup-arguments text input with inline flag autocomplete and inline
 * validation (colored token echo + per-issue messages + red invalid border).
 * Shared by the compact settings field and the full args sub-page, so the
 * correctness check shows wherever the raw field appears.
 */

const props = withDefaults(
  defineProps<{
    modelValue: string
    schema: ComfyArgDef[]
    placeholder?: string
    ariaLabel?: string
  }>(),
  {
    placeholder: '',
    ariaLabel: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
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

// Inline validation: colored tokens + per-issue messages so unsupported flags,
// missing values, and stray positionals are visible instead of silently
// surviving. The trailing flag being typed is held off while focused.
const validation = computed(() =>
  props.schema.length
    ? validateArgs(localValue.value, props.schema, { suppressTrailingPartial: focused.value })
    : null,
)
const hasIssues = computed(() => validation.value?.hasIssues ?? false)
const showTokenDisplay = computed(() => hasIssues.value || validation.value?.awaiting != null)

function handleInput(value: string): void {
  localValue.value = value
  emit('update:modelValue', value)
}

function handleChange(value: string): void {
  emit('change', value)
}

function onFocus(): void {
  focused.value = true
}
function onBlur(): void {
  focused.value = false
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
      :spellcheck="false"
      :model-value="localValue"
      :placeholder="placeholder || t('comfyUISettings.argsPlaceholder', 'No arguments set')"
      :aria-label="ariaLabel"
      :invalid="hasIssues"
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

    <!-- Colored echo of the raw string so problem tokens are easy to spot. -->
    <div
      v-if="validation && showTokenDisplay && validation.tokens.length"
      class="args-raw-tokens"
      aria-hidden="true"
    >
      <span
        v-for="(tok, i) in validation.tokens"
        :key="i"
        :class="{
          'token-bad': tok.status === 'unsupported' || tok.status === 'orphaned',
          'token-missing': tok.status === 'missing-value',
          'token-awaiting': tok.status === 'awaiting-value',
          'token-partial': tok.status === 'partial',
        }"
        :title="tok.tooltip || ''"
        >{{ tok.text }}</span
      >
    </div>

    <template v-if="validation">
      <p v-if="validation.awaiting" class="args-raw-validation args-raw-validation-info" role="status">
        <AlertCircle :size="12" aria-hidden="true" />
        <span>
          {{ validation.awaiting.text }}
          {{ t('comfyUISettings.argsAwaitingValue', 'expects a value') }}
        </span>
      </p>
      <p
        v-if="validation.unsupportedFlags.length > 0"
        class="args-raw-validation args-raw-validation-error"
        role="status"
      >
        <AlertCircle :size="12" aria-hidden="true" />
        <span>
          {{ t('comfyUISettings.argsUnsupported', 'Unsupported:') }}
          <code v-for="flag in validation.unsupportedFlags" :key="flag" class="args-raw-bad-flag"
            >--{{ flag }}</code
          >
        </span>
      </p>
      <p
        v-if="validation.missingValueFlags.length > 0"
        class="args-raw-validation args-raw-validation-warn"
        role="status"
      >
        <AlertCircle :size="12" aria-hidden="true" />
        <span>
          {{ t('comfyUISettings.argsMissingValue', 'Missing value for:') }}
          <code v-for="flag in validation.missingValueFlags" :key="flag" class="args-raw-bad-flag">{{
            flag
          }}</code>
        </span>
      </p>
      <p
        v-if="validation.orphanedTokens.length > 0"
        class="args-raw-validation args-raw-validation-error"
        role="status"
      >
        <AlertCircle :size="12" aria-hidden="true" />
        <span>
          {{ t('comfyUISettings.argsUnexpected', 'Unexpected:') }}
          <code v-for="tok in validation.orphanedTokens" :key="tok" class="args-raw-bad-flag">{{
            tok
          }}</code>
        </span>
      </p>
    </template>
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

/* Colored echo of the raw string: each problem token underlined in its color. */
.args-raw-tokens {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin: 6px 0 0;
  padding: 6px 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 6px;
}

.args-raw-tokens .token-bad {
  color: var(--danger);
  text-decoration: underline wavy;
  text-underline-offset: 3px;
}

.args-raw-tokens .token-missing {
  color: var(--warning);
  text-decoration: underline wavy;
  text-underline-offset: 3px;
}

.args-raw-tokens .token-awaiting {
  color: var(--accent-primary);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
}

/* Trailing flag still being typed: dimmed, no error decoration. */
.args-raw-tokens .token-partial {
  color: var(--text-muted);
  opacity: 0.6;
}

.args-raw-validation {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 0;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.5;
  border-radius: 6px;
}

.args-raw-validation :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}

.args-raw-validation-error {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.args-raw-validation-warn {
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
}

.args-raw-validation-info {
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
}

.args-raw-bad-flag {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, currentcolor 14%, transparent);
}
</style>
