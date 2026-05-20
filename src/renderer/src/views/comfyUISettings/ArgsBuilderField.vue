<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Settings } from 'lucide-vue-next'
import BaseInput from '../../components/ui/BaseInput.vue'
import type { ComfyArgDef, DetailField } from '../../types/ipc'
import { useArgsAutocomplete } from '../../composables/useArgsAutocomplete'

/**
 * Compact summary row for the `launchArgs` field. Shows the current
 * arg string (or a placeholder when empty) with an inline gear icon
 * docked on the input's right edge that opens the `ArgsBuilderPage`
 * sub-page.
 *
 * Carries the inline-autocomplete affordance from the legacy
 * ArgsBuilder modal: typing a partial flag (e.g. `--lo`) drops a
 * popover of matching schema flags with help text below the input.
 * The drawer's 400px width can't fit the categorized editor inline,
 * but it can fit a focused suggestion list — and surfacing it here
 * matches the user's muscle memory from the legacy field.
 *
 * Schema is loaded once per `installationId` via `get-comfy-args`,
 * same IPC the sub-page uses. The prop is optional so non-launchArgs
 * surfaces (e.g. instance-picker contexts that don't know an install
 * id yet) degrade gracefully to a plain text input.
 */

interface Props {
  field: DetailField
  installationId?: string
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
const localValue = ref(stringValue.value)
watch(stringValue, (v) => {
  // Parent commits round-trip into us — keep the mirror in sync.
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
    // Silent failure — the field still works as a plain text input.
    schema.value = []
  }
}

onMounted(() => void loadSchema(props.installationId))
watch(() => props.installationId, (id) => void loadSchema(id))

const rowRef = ref<HTMLElement | null>(null)
const focused = ref(false)

const autocomplete = useArgsAutocomplete({
  value: localValue,
  schema,
  focused,
  onAccept(next) {
    localValue.value = next
    emit('update', props.field, next)
    void nextTick(() => {
      const input = rowRef.value?.querySelector('input')
      if (input) {
        input.focus()
        const len = input.value.length
        input.setSelectionRange(len, len)
      }
    })
  },
})

function handleEdit(): void {
  emit('open')
}

function handleInput(value: string): void {
  // Live mirror so the autocomplete sees every keystroke. Defer the
  // parent commit to `@change` (blur/Enter) so we don't thrash the
  // IPC update pipeline on every character.
  localValue.value = value
}

function handleChange(value: string): void {
  emit('update', props.field, value)
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
    ref="rowRef"
    class="args-field-row"
    @focusin="onFocus"
    @focusout="onBlur"
    @keydown="onKeydown"
  >
    <BaseInput
      mono
      :model-value="localValue"
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
    </BaseInput>
    <ul
      v-if="autocomplete.visible.value"
      class="args-field-ac"
      role="listbox"
      :aria-label="t('comfyUISettings.argsAutocompleteLabel', 'Argument suggestions')"
    >
      <li
        v-for="(m, i) in autocomplete.matches.value"
        :key="m.name"
        class="args-field-ac-item"
        :class="{ selected: i === autocomplete.acIndex.value }"
        role="option"
        :aria-selected="i === autocomplete.acIndex.value"
        @mousedown.prevent="autocomplete.completeArg(m.name)"
        @mouseenter="autocomplete.acIndex.value = i"
      >
        <span class="args-field-ac-flag">{{ m.flag }}</span>
        <span v-if="m.type !== 'boolean'" class="args-field-ac-meta">
          {{ m.metavar ? (m.type === 'optional-value' ? `[${m.metavar}]` : m.metavar) : '' }}
        </span>
        <span class="args-field-ac-help">{{ m.help }}</span>
      </li>
      <li class="args-field-ac-hint" aria-hidden="true">
        {{ t('comfyUISettings.argsAutocompleteHint', '↑↓ navigate · Tab/Enter select · Esc dismiss') }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.args-field-row {
  position: relative;
}

/* Inline autocomplete popover — anchored under the BaseInput while
 * typing a partial flag. Tokens only; matches the BaseSelect listbox
 * chrome so the two surfaces read as the same family. */
.args-field-ac {
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

.args-field-ac-item {
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

.args-field-ac-item.selected,
.args-field-ac-item:hover {
  background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
}

.args-field-ac-flag {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-weight: 600;
  color: var(--accent-primary);
  flex-shrink: 0;
}

.args-field-ac-meta {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.args-field-ac-help {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.args-field-ac-hint {
  padding: 4px 8px 2px;
  font-size: 10px;
  color: color-mix(in srgb, var(--text-muted) 70%, transparent);
  border-top: 1px solid var(--border);
  margin-top: 2px;
  text-align: right;
  cursor: default;
}
</style>
