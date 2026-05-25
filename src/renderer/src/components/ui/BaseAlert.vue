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
  /** Primary-action visual treatment. `danger` = destructive (red),
   *  `primary` = standard yellow CTA. Default `'primary'`. */
  tone?: 'primary' | 'danger'
  ariaLabel?: string
  ariaLabelledby?: string
  /** Dismiss when Escape is pressed. Default true. */
  dismissOnEscape?: boolean
  /** Dismiss when the backdrop is clicked. Default true. */
  dismissOnOutside?: boolean
  /** Lock body scroll while open. Default true. */
  preventScroll?: boolean
  /** Optional `data-testid` for the overlay root. Lets singleton hosts
   *  (ModalDialog) tag a specific dialog (e.g. stop-instance confirm)
   *  without renaming the default selectors. */
  testIdRoot?: string
  /** Optional `data-testid` override for the primary action button.
   *  Defaults to `'base-alert-action'`. */
  testIdAction?: string
  /** Optional `data-testid` override for the cancel button.
   *  Defaults to `'base-alert-cancel'`. */
  testIdCancel?: string
}

const props = withDefaults(defineProps<Props>(), {
  message: '',
  buttonLabel: undefined,
  showCancel: false,
  cancelLabel: undefined,
  tone: 'primary',
  ariaLabel: undefined,
  ariaLabelledby: undefined,
  dismissOnEscape: true,
  dismissOnOutside: true,
  preventScroll: true,
  testIdRoot: undefined,
  testIdAction: undefined,
  testIdCancel: undefined
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
        :data-testid="testIdRoot"
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
                :data-testid="testIdCancel ?? 'base-alert-cancel'"
                @click="onCancelClick"
              >
                {{ cancelLabel ?? $t('common.cancel') }}
              </button>
              <button
                ref="actionBtnRef"
                type="button"
                :class="tone === 'danger' ? 'danger-solid' : 'primary'"
                :data-testid="testIdAction ?? 'base-alert-action'"
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
  /* Alerts always sit above other modals (legacy `.modal-overlay` is
   * 100, DetailModal's `.view-modal` is 50, ProgressModal overlay is
   * 100). When an alert fires from inside a modal-driven action chain
   * — e.g. right-click → Delete confirm — the alert must own the
   * foreground, not stack behind its parent surface. Context menus
   * (10000) intentionally still win. */
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: clamp(32px, 6vh, 72px) clamp(16px, 4vw, 48px);
  background: color-mix(in oklab, var(--neutral-800) 60%, transparent);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
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
  /* Match the popup-shell chrome used on the instance picker / global
   * settings windows: a soft white-tinted hairline plus a layered
   * shadow that reads as elevation rather than a hard drop. */
  border: 1px solid var(--chooser-surface-border);
  box-shadow: var(--modal-surface-shadow);
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

/* Tone-scoped destructive red. The global `--danger` (#b33a3a) reads
 * muddy against the plum-warm neutral-800 panel surface; a slightly
 * warmer, more saturated tone sits cleaner on this palette without
 * tipping into neon. Scoped to BaseAlert so the global token (used
 * across the app) stays untouched. */
.base-alert-panel button.danger-solid {
  --base-alert-danger: #c8443d;
  background: var(--base-alert-danger);
  border-color: var(--base-alert-danger);
  color: #fff;
}
.base-alert-panel button.danger-solid:hover {
  background: color-mix(in srgb, var(--base-alert-danger) 88%, #000);
  border-color: color-mix(in srgb, var(--base-alert-danger) 88%, #000);
}
.base-alert-panel button.danger-solid:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--base-alert-danger) 60%, #fff);
  outline-offset: 2px;
}
</style>
