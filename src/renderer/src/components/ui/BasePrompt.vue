<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import BaseModal from './BaseModal.vue'
import { linkify, handleModalLinkClick } from '../../lib/modalLinkify'
import { TID } from '../../../../shared/testIds'
import type { ModalDetailGroup } from '../../types/ipc'

/**
 * Prompt primitive — title, message, single text input, Cancel +
 * primary action. Composes `BaseModal` for the shell (teleport,
 * overlay, focus capture, scroll lock, ESC, a11y). Use for any
 * "name this thing" affordance previously routed through
 * `useModal().prompt()`.
 *
 * Two-way `open` via `v-model:open` so the call site doesn't have to
 * juggle local ref + listener.
 */

interface Props {
  open: boolean
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Inline-label above the text field. Defaults to i18n `common.name`. */
  inputLabel?: string
  /** When truthy, empty submissions show an inline error. A string
   *  value overrides the default error copy. */
  required?: boolean | string
  /** Optional recessed sub-blocks rendered below the message (e.g.
   *  release notes for the Copy and Update prompt). */
  messageDetails?: ModalDetailGroup[]
  size?: 'sm' | 'md' | 'lg' | 'xl'
  dismissOnEscape?: boolean
  dismissOnOutside?: boolean
  testIdInput?: string
  testIdAction?: string
  testIdCancel?: string
}

const props = withDefaults(defineProps<Props>(), {
  message: '',
  placeholder: '',
  defaultValue: '',
  confirmLabel: undefined,
  cancelLabel: undefined,
  inputLabel: undefined,
  required: false,
  messageDetails: () => [],
  size: 'sm',
  dismissOnEscape: true,
  dismissOnOutside: true,
  testIdInput: undefined,
  testIdAction: undefined,
  testIdCancel: undefined
})

const emit = defineEmits<{
  'update:open': [open: boolean]
  submit: [value: string]
  cancel: []
}>()

const TITLE_ID = 'base-prompt-title'

const inputRef = ref<HTMLInputElement | null>(null)
const inputValue = ref('')
const error = ref('')

const linkifiedMessage = computed(() => linkify(props.message))

function cancel(): void {
  emit('update:open', false)
  emit('cancel')
}

function submit(): void {
  const value = inputValue.value.trim()
  if (props.required && !value) {
    error.value = typeof props.required === 'string' ? props.required : 'This field is required'
    return
  }
  emit('update:open', false)
  emit('submit', value)
}

watch(
  () => props.open,
  (isOpen, wasOpen) => {
    if (isOpen && !wasOpen) {
      inputValue.value = props.defaultValue
      error.value = ''
      void nextTick(() => {
        inputRef.value?.focus()
        inputRef.value?.select()
      })
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
    content-class="base-prompt-panel"
    @close="cancel"
  >
    <template #header>
      <h2 :id="TITLE_ID" class="base-prompt-title">{{ title }}</h2>
    </template>

    <div class="base-prompt-body">
      <div
        v-if="message"
        class="base-prompt-message"
        @click="handleModalLinkClick"
        v-html="linkifiedMessage"
      ></div>

      <div v-if="messageDetails.length" class="base-prompt-details">
        <div
          v-for="(group, gi) in messageDetails"
          :key="gi"
          class="base-prompt-detail-group"
        >
          <span class="base-prompt-detail-label">{{ group.label }}</span>
          <div class="base-prompt-detail-recessed" @click="handleModalLinkClick">
            <div
              v-for="(item, ii) in group.items"
              :key="ii"
              class="base-prompt-detail-item"
              v-html="linkify(item)"
            ></div>
          </div>
        </div>
      </div>

      <div class="base-prompt-field">
        <label class="base-prompt-field-label">
          {{ inputLabel ?? $t('common.name') }}
        </label>
        <input
          ref="inputRef"
          v-model="inputValue"
          type="text"
          class="base-prompt-input"
          :placeholder="placeholder"
          :data-testid="testIdInput ?? TID.basePromptInput"
          @keydown.enter.prevent.stop="submit"
        />
        <div v-if="error" class="base-prompt-error">{{ error }}</div>
      </div>
    </div>

    <template #footer>
      <button
        type="button"
        :data-testid="testIdCancel ?? TID.basePromptCancel"
        @click="cancel"
      >
        {{ cancelLabel ?? $t('common.cancel') }}
      </button>
      <button
        type="button"
        class="primary"
        :data-testid="testIdAction ?? TID.basePromptAction"
        @click="submit"
      >
        {{ confirmLabel ?? $t('modal.ok') }}
      </button>
    </template>
  </BaseModal>
</template>

<style scoped>
.base-prompt-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--neutral-100);
}

.base-prompt-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-muted);
}

.base-prompt-message {
  white-space: pre-line;
  user-select: text;
}

.base-prompt-message :deep(strong) {
  color: var(--text);
  font-weight: 600;
}

.base-prompt-message :deep(.modal-link) {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

.base-prompt-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.base-prompt-detail-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.base-prompt-detail-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.base-prompt-detail-recessed {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
  max-height: 200px;
  overflow-y: auto;
}

.base-prompt-detail-item {
  font-size: 13px;
  line-height: 1.45;
  color: var(--neutral-100);
}

.base-prompt-detail-item :deep(.modal-link) {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

.base-prompt-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.base-prompt-field-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.base-prompt-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 14px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
  color: var(--neutral-100);
  transition: border-color 0.12s ease;
}

.base-prompt-input:focus-visible {
  outline: none;
  border-color: var(--accent);
}

.base-prompt-error {
  font-size: 13px;
  color: var(--danger);
  min-height: 12px;
}
</style>
