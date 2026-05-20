<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useModalOverlay } from '../../composables/useModalOverlay'

/**
 * Reusable alert primitive (shadcn-style). Parent controls `open`;
 * the primitive owns teleport, transition, dismiss behavior, focus
 * capture+restore, body scroll lock, and a11y attrs.
 *
 * Alerts are intentionally compact (title + message + actions)
 * compared to `BaseModal`. Default is a single OK (browser `alert()`
 * semantics). Pass `showCancel` for Cancel + OK (`confirm()` semantics).
 * Use `BaseModal` when you need header/footer slots or a ✕ close button.
 *
 * `title` is required and wires `aria-labelledby` by default. Pass
 * `aria-label` when the visible title is not a sufficient accessible name.
 */

interface Props {
  open: boolean
  title: string
  message?: string
  /** Primary action label. Defaults to i18n `modal.ok`. */
  buttonLabel?: string
  /** Render Cancel + primary. ESC / backdrop emit `cancel`. Default false. */
  showCancel?: boolean
  /** Cancel label when `showCancel`. Defaults to i18n `common.cancel`. */
  cancelLabel?: string
  ariaLabel?: string
  ariaLabelledby?: string
  /** Dismiss when Escape is pressed. Default true. */
  dismissOnEscape?: boolean
  /** Dismiss when the backdrop is clicked. Default true. */
  dismissOnOutside?: boolean
  /** Lock body scroll while open. Default true. */
  preventScroll?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  message: '',
  buttonLabel: undefined,
  showCancel: false,
  cancelLabel: undefined,
  ariaLabel: undefined,
  ariaLabelledby: undefined,
  dismissOnEscape: true,
  dismissOnOutside: true,
  preventScroll: true
})

const emit = defineEmits<{ close: []; cancel: [] }>()

const TITLE_ID = 'base-alert-title'

const actionBtnRef = ref<HTMLButtonElement | null>(null)
let returnFocusTo: HTMLElement | null = null
let previousBodyOverflow: string | null = null

const dialogAriaLabel = computed(() => props.ariaLabel)
const dialogAriaLabelledby = computed(
  () => props.ariaLabelledby ?? (props.ariaLabel ? undefined : TITLE_ID)
)

function dismiss(): void {
  if (props.showCancel) emit('cancel')
  else emit('close')
}

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  () => props.open && props.dismissOnEscape,
  dismiss
)

function onOverlayMouseDown(e: MouseEvent) {
  if (!props.dismissOnOutside) return
  handleOverlayMouseDown(e)
}
function onOverlayClick(e: MouseEvent) {
  if (!props.dismissOnOutside) return
  handleOverlayClick(e)
}

function onCancelClick(): void {
  emit('cancel')
}

function onActionClick(): void {
  emit('close')
}

function lockBodyScroll(): void {
  if (!props.preventScroll) return
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
}

function unlockBodyScroll(): void {
  if (previousBodyOverflow === null) return
  document.body.style.overflow = previousBodyOverflow
  previousBodyOverflow = null
}

function captureAndFocus(): void {
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => actionBtnRef.value?.focus())
}

function restoreFocus(): void {
  try {
    returnFocusTo?.focus()
  } catch {
    /* original trigger detached */
  }
  returnFocusTo = null
}

watch(
  () => props.open,
  (isOpen, wasOpen) => {
    if (isOpen && !wasOpen) {
      lockBodyScroll()
      captureAndFocus()
    } else if (!isOpen && wasOpen) {
      unlockBodyScroll()
      restoreFocus()
    }
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  unlockBodyScroll()
  restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade" appear>
      <div
        v-if="open"
        class="base-alert-overlay"
        role="alertdialog"
        aria-modal="true"
        :aria-label="dialogAriaLabel"
        :aria-labelledby="dialogAriaLabelledby"
        @mousedown="onOverlayMouseDown"
        @click="onOverlayClick"
      >
        <div class="base-alert-panel modal-fade-panel">
          <h2 :id="TITLE_ID" class="base-alert-title">{{ title }}</h2>
          <div v-if="message || $slots.default" class="base-alert-message">
            <slot>{{ message }}</slot>
          </div>
          <footer class="base-alert-footer">
            <slot name="footer">
              <button
                v-if="showCancel"
                type="button"
                data-testid="base-alert-cancel"
                @click="onCancelClick"
              >
                {{ cancelLabel ?? $t('common.cancel') }}
              </button>
              <button
                ref="actionBtnRef"
                type="button"
                class="primary"
                data-testid="base-alert-action"
                @click="onActionClick"
              >
                {{ buttonLabel ?? $t('modal.ok') }}
              </button>
            </slot>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.base-alert-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: clamp(32px, 6vh, 72px) clamp(16px, 4vw, 48px);
  background: color-mix(in oklab, var(--neutral-800) 70%, transparent);
}

.base-alert-panel {
  display: flex;
  flex-direction: column;
  width: min(400px, 100%);
  min-width: 320px;
  max-height: min(80vh, 560px);
  border-radius: 12px;
  overflow: hidden;
  background: var(--neutral-800);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 6%, transparent);
  box-shadow: 0 24px 64px 0 rgba(0, 0, 0, 0.35);
  color: var(--neutral-100);
  padding: 16px 24px;
}

.base-alert-title {
  margin: 0 -24px 12px;
  padding: 0 24px 12px;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}

.base-alert-message {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  margin-bottom: 20px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-muted);
  white-space: pre-line;
  user-select: text;
}

.base-alert-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin: 0 -24px;
  padding: 12px 24px 0;
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}
</style>
