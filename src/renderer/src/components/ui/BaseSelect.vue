<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'

// Custom select primitive: trigger + popover listbox, teleported to <body>
// so a drawer host's overflow:hidden can't clip it.

export interface BaseSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface Props {
  modelValue: string
  options: BaseSelectOption[]
  ariaLabel?: string
  placeholder?: string
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  ariaLabel: undefined,
  placeholder: '',
  disabled: false
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const triggerRef = ref<HTMLButtonElement | null>(null)
const listboxRef = ref<HTMLUListElement | null>(null)
const open = ref(false)
const activeIndex = ref(-1)
const popoverStyle = ref<Record<string, string>>({})

const selectedOption = computed(() => props.options.find((o) => o.value === props.modelValue))

const triggerLabel = computed(() => selectedOption.value?.label ?? props.placeholder)

const listboxId = `ui-listbox-${Math.random().toString(36).slice(2, 9)}`

function updatePosition(): void {
  const trigger = triggerRef.value
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const spaceBelow = window.innerHeight - rect.bottom
  const spaceAbove = rect.top
  const desiredHeight = Math.min(props.options.length * 36 + 16, 280)
  const openUp = spaceBelow < desiredHeight + 8 && spaceAbove > spaceBelow
  popoverStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    top: openUp ? 'auto' : `${rect.bottom + 2}px`,
    bottom: openUp ? `${window.innerHeight - rect.top + 2}px` : 'auto',
    maxHeight: `${Math.max(spaceBelow, spaceAbove) - 16}px`,
    zIndex: '9999'
  }
}

function openPanel(): void {
  if (open.value || props.disabled) return
  open.value = true
  const idx = props.options.findIndex((o) => o.value === props.modelValue && !o.disabled)
  activeIndex.value = idx >= 0 ? idx : props.options.findIndex((o) => !o.disabled)
  updatePosition()
  void nextTick(() => {
    listboxRef.value?.focus()
    scrollActiveIntoView()
  })
}

function closePanel(returnFocus = true): void {
  if (!open.value) return
  open.value = false
  if (returnFocus) {
    void nextTick(() => triggerRef.value?.focus())
  }
}

function toggle(): void {
  if (open.value) closePanel()
  else openPanel()
}

function selectIndex(i: number): void {
  const opt = props.options[i]
  if (!opt || opt.disabled) return
  emit('update:modelValue', opt.value)
  closePanel()
}

function moveActive(delta: number): void {
  const len = props.options.length
  if (len === 0) return
  let i = activeIndex.value
  for (let step = 0; step < len; step++) {
    i = (i + delta + len) % len
    if (!props.options[i]?.disabled) {
      activeIndex.value = i
      scrollActiveIntoView()
      return
    }
  }
}

function scrollActiveIntoView(): void {
  const list = listboxRef.value
  if (!list) return
  const el = list.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`)
  el?.scrollIntoView({ block: 'nearest' })
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (
    event.key === 'ArrowDown' ||
    event.key === 'ArrowUp' ||
    event.key === 'Enter' ||
    event.key === ' '
  ) {
    event.preventDefault()
    openPanel()
  }
}

function onListboxKeydown(event: KeyboardEvent): void {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      moveActive(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      moveActive(-1)
      break
    case 'Home':
      event.preventDefault()
      activeIndex.value = props.options.findIndex((o) => !o.disabled)
      scrollActiveIntoView()
      break
    case 'End':
      event.preventDefault()
      for (let i = props.options.length - 1; i >= 0; i--) {
        if (!props.options[i]?.disabled) {
          activeIndex.value = i
          scrollActiveIntoView()
          break
        }
      }
      break
    case 'Enter':
    case ' ':
      event.preventDefault()
      if (activeIndex.value >= 0) selectIndex(activeIndex.value)
      break
    case 'Escape':
      event.preventDefault()
      closePanel()
      break
    case 'Tab':
      closePanel(false)
      break
  }
}

function onDocPointer(event: PointerEvent): void {
  if (!open.value) return
  const t = event.target as Node | null
  if (t && !triggerRef.value?.contains(t) && !listboxRef.value?.contains(t)) {
    closePanel(false)
  }
}

function onWindowChange(): void {
  if (open.value) updatePosition()
}

function onWindowBlur(): void {
  // Close on focus loss to another window (e.g. clicking out of the IPP).
  // The document `pointerdown` listener doesn't catch that because the
  // click lands in a different WebContents — the dropdown would otherwise
  // stay open and resurface when the user returns.
  if (open.value) closePanel(false)
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocPointer, true)
    window.addEventListener('resize', onWindowChange)
    window.addEventListener('scroll', onWindowChange, true)
    window.addEventListener('blur', onWindowBlur)
  } else {
    document.removeEventListener('pointerdown', onDocPointer, true)
    window.removeEventListener('resize', onWindowChange)
    window.removeEventListener('scroll', onWindowChange, true)
    window.removeEventListener('blur', onWindowBlur)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  window.removeEventListener('resize', onWindowChange)
  window.removeEventListener('scroll', onWindowChange, true)
})
</script>

<template>
  <button
    ref="triggerRef"
    type="button"
    class="ui-select-trigger"
    role="combobox"
    :aria-expanded="open"
    :aria-controls="listboxId"
    aria-haspopup="listbox"
    :aria-label="ariaLabel"
    :data-placeholder="!selectedOption ? '' : undefined"
    :disabled="disabled"
    @click="toggle"
    @keydown="onTriggerKeydown"
  >
    <span class="ui-select-label">{{ triggerLabel }}</span>
    <ChevronDown :size="14" class="ui-select-chevron" :data-open="open ? '' : undefined" />
  </button>

  <Teleport to="body">
    <Transition name="ui-select-pop">
      <ul
        v-if="open"
        :id="listboxId"
        ref="listboxRef"
        class="ui-select-listbox"
        role="listbox"
        tabindex="-1"
        :style="popoverStyle"
        :aria-label="ariaLabel"
        @keydown="onListboxKeydown"
      >
        <li
          v-for="(opt, i) in options"
          :key="opt.value"
          class="ui-select-option"
          role="option"
          :data-index="i"
          :data-active="i === activeIndex ? '' : undefined"
          :data-selected="opt.value === modelValue ? '' : undefined"
          :aria-selected="opt.value === modelValue"
          :aria-disabled="opt.disabled || undefined"
          @mousemove="activeIndex = i"
          @click="selectIndex(i)"
        >
          <span class="ui-select-option-body">
            <span class="ui-select-option-label">{{ opt.label }}</span>
            <span v-if="opt.description" class="ui-select-option-desc">{{ opt.description }}</span>
          </span>
          <Check v-if="opt.value === modelValue" :size="14" class="ui-select-option-check" />
        </li>
      </ul>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  color: var(--neutral-100);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}

.ui-select-trigger:hover:not(:disabled) {
  border-color: var(--border-hover);
  background: color-mix(in srgb, var(--neutral-100) 4%, var(--neutral-800));
}

.ui-select-trigger:focus-visible {
  outline: none;
  border-color: var(--accent-primary);
}

.ui-select-trigger[aria-expanded='true'] {
  border-color: var(--accent-primary);
}

.ui-select-trigger[data-placeholder] .ui-select-label {
  color: var(--text-muted);
}

.ui-select-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.ui-select-chevron[data-open] {
  transform: rotate(180deg);
}

.ui-select-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>

<style>
/* Listbox is teleported to <body>, so it can't be scoped. */
.ui-select-listbox {
  margin: 0;
  padding: 4px;
  list-style: none;
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.28),
    0 2px 6px rgba(0, 0, 0, 0.18);
  overflow-y: auto;
  outline: none;
}

.ui-select-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  color: var(--text);
  font-size: 14px;
  cursor: pointer;
  user-select: none;
}

.ui-select-option[data-active] {
  background: var(--border-hover);
}

.ui-select-option[data-selected] {
  color: var(--text);
}

.ui-select-option[aria-disabled='true'] {
  color: var(--text-muted);
  cursor: not-allowed;
}

.ui-select-option-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ui-select-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select-option-desc {
  color: var(--text-muted);
  font-size: var(--takeover-fs-caption);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ui-select-option-check {
  flex-shrink: 0;
  color: var(--accent-primary);
}

.ui-select-pop-enter-active,
.ui-select-pop-leave-active {
  transition:
    opacity 150ms ease-out,
    transform 150ms ease-out;
}

.ui-select-pop-enter-from,
.ui-select-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .ui-select-chevron,
  .ui-select-pop-enter-active,
  .ui-select-pop-leave-active {
    transition-duration: 0ms;
  }
}
</style>
