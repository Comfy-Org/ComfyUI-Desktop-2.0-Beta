<script setup lang="ts">
import { computed, useSlots } from 'vue'

interface Props {
  modelValue: string
  placeholder?: string
  ariaLabel?: string
  mono?: boolean
  readonly?: boolean
  invalid?: boolean
  type?: string
  // Number-input hints. Only meaningful when `type === 'number'`; the
  // browser handles clamp + step UI from these.
  min?: number
  max?: number
  step?: number
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  ariaLabel: undefined,
  mono: false,
  readonly: false,
  invalid: false,
  type: 'text',
  min: undefined,
  max: undefined,
  step: undefined,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const slots = useSlots()
const hasLeading = computed(() => !!slots.leading)
const hasTrailing = computed(() => !!slots.trailing)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

function onChange(event: Event): void {
  emit('change', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div
    class="ui-input"
    :data-mono="mono ? '' : undefined"
    :data-readonly="readonly ? '' : undefined"
    :data-invalid="invalid ? '' : undefined"
    :data-leading="hasLeading ? '' : undefined"
    :data-trailing="hasTrailing ? '' : undefined"
  >
    <span v-if="hasLeading" class="ui-input-leading">
      <slot name="leading" />
    </span>
    <input
      class="ui-input-control"
      :type="type"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      :aria-invalid="invalid || undefined"
      :readonly="readonly"
      :min="min"
      :max="max"
      :step="step"
      @input="onInput"
      @change="onChange"
    />
    <span v-if="hasTrailing" class="ui-input-trailing">
      <slot name="trailing" />
    </span>
  </div>
</template>

<style scoped>
.ui-input {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: border-color 150ms ease;
  gap: 8px;
}

.ui-input:focus-within {
  border-color: var(--accent-primary);
}

.ui-input[data-invalid] {
  border-color: var(--danger);
}

.ui-input-control {
  flex: 1;
  min-width: 0;
  padding: 0px 10px 6px 10px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
}

.ui-input[data-mono] .ui-input-control {
  font-size: 14px;
}

.ui-input[data-readonly] .ui-input-control {
  color: var(--text-muted);
  cursor: default;
}

.ui-input-control::placeholder {
  color: var(--neutral-100);
  opacity: 0.67;
}

.ui-input[data-leading] .ui-input-control {
  padding-left: 4px;
}

.ui-input[data-trailing] .ui-input-control {
  padding-right: 4px;
}

.ui-input-leading,
.ui-input-trailing {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-muted);
}

.ui-input-leading {
  padding-left: 8px;
}

.ui-input-trailing {
  padding-right: 6px;
}

/* Style icon-buttons placed in the trailing/leading slot to feel
 * native to the input chrome — small square hit area, muted icon,
 * accent on hover/focus. Consumers can opt out with their own class. */
.ui-input-trailing :deep(button),
.ui-input-leading :deep(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    color 150ms ease,
    background-color 150ms ease;
}

.ui-input-trailing :deep(button:hover),
.ui-input-leading :deep(button:hover) {
  color: var(--text);
  background: var(--border-hover);
}

.ui-input-trailing :deep(button:focus-visible),
.ui-input-leading :deep(button:focus-visible) {
  outline: 2px solid var(--accent-primary);
  outline-offset: -2px;
  color: var(--text);
}
</style>
