<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'

// Action-sheet primitive: title, message, list of choices, Cancel footer.
// Not BaseSelect.vue, which is the inline form combobox.

export interface ActionSheetItem {
  value: string
  label: string
  description?: string
  tone?: 'default' | 'danger'
}

interface Props {
  open: boolean
  title: string
  message?: string
  items: ActionSheetItem[]
  cancelLabel?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  dismissOnEscape?: boolean
  dismissOnOutside?: boolean
  testIdCancel?: string
}

const props = withDefaults(defineProps<Props>(), {
  message: '',
  cancelLabel: undefined,
  size: 'sm',
  dismissOnEscape: true,
  dismissOnOutside: true,
  testIdCancel: undefined
})

const emit = defineEmits<{
  'update:open': [open: boolean]
  select: [value: string]
  cancel: []
}>()

const TITLE_ID = 'base-action-sheet-title'

const firstItemRef = ref<HTMLButtonElement | null>(null)

function cancel(): void {
  emit('update:open', false)
  emit('cancel')
}

function onItemClick(value: string): void {
  emit('update:open', false)
  emit('select', value)
}

watch(
  () => props.open,
  (isOpen, wasOpen) => {
    if (isOpen && !wasOpen) {
      void nextTick(() => firstItemRef.value?.focus())
    }
  },
  { immediate: true }
)
</script>

<template>
  <BaseModal
    :open="open"
    :size="size"
    :aria-labelledby="TITLE_ID"
    :dismiss-on-escape="dismissOnEscape"
    :dismiss-on-outside="dismissOnOutside"
    :show-close-button="false"
    content-class="base-action-sheet-panel"
    @close="cancel"
  >
    <template #header>
      <h2 :id="TITLE_ID" class="base-action-sheet-title">{{ title }}</h2>
    </template>

    <div class="base-action-sheet-body">
      <div v-if="message" class="base-action-sheet-message">{{ message }}</div>
      <div class="base-action-sheet-list">
        <button
          v-for="(item, idx) in items"
          :key="item.value"
          :ref="(el) => { if (idx === 0) firstItemRef = el as HTMLButtonElement }"
          type="button"
          class="base-action-sheet-item"
          :class="{ 'base-action-sheet-item--danger': item.tone === 'danger' }"
          :data-testid="`base-action-sheet-item-${item.value}`"
          @click="onItemClick(item.value)"
        >
          <span class="base-action-sheet-item-label">{{ item.label }}</span>
          <span v-if="item.description" class="base-action-sheet-item-desc">
            {{ item.description }}
          </span>
        </button>
      </div>
    </div>

    <template #footer>
      <button
        type="button"
        :data-testid="testIdCancel ?? 'base-action-sheet-cancel'"
        @click="cancel"
      >
        {{ cancelLabel ?? $t('common.cancel') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.base-action-sheet-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--neutral-100);
}

.base-action-sheet-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-muted);
}

.base-action-sheet-message {
  white-space: pre-line;
  user-select: text;
}

.base-action-sheet-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.base-action-sheet-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid color-mix(in oklab, var(--neutral-100) 10%, transparent);
  border-radius: 8px;
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
  cursor: pointer;
  text-align: left;
  font-size: 14px;
  color: var(--neutral-100);
  transition: border-color 0.12s ease, background 0.12s ease;
}

.base-action-sheet-item:hover,
.base-action-sheet-item:focus-visible {
  border-color: var(--accent);
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  outline: none;
}

.base-action-sheet-item--danger {
  border-color: color-mix(in oklab, var(--danger) 35%, transparent);
}

.base-action-sheet-item--danger:hover,
.base-action-sheet-item--danger:focus-visible {
  border-color: var(--danger);
  background: color-mix(in oklab, var(--danger) 12%, transparent);
}

.base-action-sheet-item-label {
  font-weight: 500;
  color: var(--neutral-100);
}

.base-action-sheet-item--danger .base-action-sheet-item-label {
  color: var(--danger);
}

.base-action-sheet-item-desc {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
