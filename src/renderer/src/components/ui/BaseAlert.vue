<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useModalOverlay } from '../../composables/useModalOverlay'
import { linkify, handleModalLinkClick } from '../../lib/modalLinkify'
import type { ModalDetailGroup } from '../../types/ipc'

// Compact alert primitive. Footer supports up to three actions in order
// `[Cancel] [Secondary] [Primary]`. Use BaseModal for richer header/footer
// needs; not BaseSelect (the inline form combobox).

interface Props {
  open: boolean
  title: string
  message?: string
  buttonLabel?: string
  /** Render Cancel + primary; ESC / backdrop emit `cancel`. */
  showCancel?: boolean
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  /** Middle action between Cancel and Primary; emits `@secondary`. */
  secondaryLabel?: string
  secondaryTone?: 'primary' | 'danger' | 'default'
  /** Header ✕ that emits `cancel`. Mutually exclusive with `showCancel`. */
  showCloseIcon?: boolean
  /** Recessed sub-blocks below the message (release notes, change summaries). */
  messageDetails?: ModalDetailGroup[]
  ariaLabel?: string
  ariaLabelledby?: string
  dismissOnEscape?: boolean
  dismissOnOutside?: boolean
  preventScroll?: boolean
  testIdRoot?: string
  testIdAction?: string
  testIdCancel?: string
  testIdSecondary?: string
  testIdCloseIcon?: string
}

const props = withDefaults(defineProps<Props>(), {
  message: '',
  buttonLabel: undefined,
  showCancel: false,
  cancelLabel: undefined,
  tone: 'primary',
  secondaryLabel: undefined,
  secondaryTone: 'default',
  showCloseIcon: false,
  messageDetails: () => [],
  ariaLabel: undefined,
  ariaLabelledby: undefined,
  dismissOnEscape: true,
  dismissOnOutside: true,
  preventScroll: true,
  testIdRoot: undefined,
  testIdAction: undefined,
  testIdCancel: undefined,
  testIdSecondary: undefined,
  testIdCloseIcon: undefined
})

const emit = defineEmits<{ close: []; cancel: []; secondary: [] }>()

const TITLE_ID = 'base-alert-title'

const dialogRef = ref<HTMLElement | null>(null)
let returnFocusTo: HTMLElement | null = null
let previousBodyOverflow: string | null = null

const dialogAriaLabel = computed(() => props.ariaLabel)
const dialogAriaLabelledby = computed(
  () => props.ariaLabelledby ?? (props.ariaLabel ? undefined : TITLE_ID)
)

// ESC + backdrop dismiss as cancel when a cancel affordance exists,
// else as primary OK. Secondary never receives ESC/backdrop dismissal.
function dismiss(): void {
  if (props.showCancel || props.showCloseIcon) emit('cancel')
  else emit('close')
}

const hasDetails = computed(() => props.messageDetails.length > 0)
const linkifiedMessage = computed(() => linkify(props.message))
// A secondary action means two non-cancel buttons, which need a wider panel.
const hasWideActions = computed(() => !!props.secondaryLabel)

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

function onSecondaryClick(): void {
  emit('secondary')
}

function onCloseIconClick(): void {
  emit('cancel')
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
  // Focus the dialog container, not the action button — keeps focus trapped for
  // keyboard/AT without painting a focus-visible ring on open.
  void nextTick(() => dialogRef.value?.focus())
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
        ref="dialogRef"
        class="base-alert-overlay"
        role="alertdialog"
        aria-modal="true"
        :aria-label="dialogAriaLabel"
        :aria-labelledby="dialogAriaLabelledby"
        :data-testid="testIdRoot"
        tabindex="-1"
        @mousedown="onOverlayMouseDown"
        @click="onOverlayClick"
      >
        <div
          class="base-alert-panel modal-fade-panel"
          :class="{
            'base-alert-panel--rich': hasDetails,
            'base-alert-panel--wide-actions': hasWideActions
          }"
        >
          <header class="base-alert-header">
            <h2 :id="TITLE_ID" class="base-alert-title">{{ title }}</h2>
            <button
              v-if="showCloseIcon"
              type="button"
              class="base-alert-close-icon"
              :aria-label="$t('common.close')"
              :data-testid="testIdCloseIcon ?? 'base-alert-close-icon'"
              @click="onCloseIconClick"
            >
              <X :size="16" />
            </button>
          </header>
          <div
            v-if="message || hasDetails || $slots.default || $slots.extra"
            class="base-alert-message"
          >
            <slot>
              <div
                v-if="message"
                class="base-alert-message-text"
                @click="handleModalLinkClick"
                v-html="linkifiedMessage"
              ></div>
              <div v-if="hasDetails" class="base-alert-details">
                <div
                  v-for="(group, gi) in messageDetails"
                  :key="gi"
                  class="base-alert-detail-group"
                >
                  <span class="base-alert-detail-label">{{ group.label }}</span>
                  <div class="base-alert-detail-recessed" @click="handleModalLinkClick">
                    <div
                      v-for="(item, ii) in group.items"
                      :key="ii"
                      class="base-alert-detail-item"
                      v-html="linkify(item)"
                    ></div>
                  </div>
                </div>
              </div>
            </slot>
            <!-- Sits below message + details (unlike the default slot, which replaces them). -->
            <div v-if="$slots.extra" class="base-alert-extra">
              <slot name="extra" />
            </div>
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
                v-if="secondaryLabel"
                type="button"
                :class="
                  secondaryTone === 'danger'
                    ? 'danger-solid'
                    : secondaryTone === 'primary'
                      ? 'primary'
                      : ''
                "
                :data-testid="testIdSecondary ?? 'base-alert-secondary'"
                @click="onSecondaryClick"
              >
                {{ secondaryLabel }}
              </button>
              <button
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
  /* Alerts sit above other modals so a confirm fired from inside one owns
   * the foreground; context menus (10000) still win. */
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
  width: min(440px, 100%);
  min-width: 320px;
  max-height: min(80vh, 560px);
  border-radius: 12px;
  overflow: hidden;
  background: var(--neutral-800);
  border: 1px solid var(--chooser-surface-border);
  box-shadow: var(--modal-surface-shadow);
  color: var(--neutral-100);
  padding: 16px 24px;
}

/* Rich variant widens the panel and lets the body scroll. */
.base-alert-panel--rich {
  width: min(480px, 100%);
  max-height: min(80vh, 640px);
}

/* Wider panel so two non-cancel actions sit side-by-side on one line. */
.base-alert-panel--wide-actions {
  width: min(520px, 100%);
}

.base-alert-panel--rich.base-alert-panel--wide-actions {
  width: min(540px, 100%);
}

.base-alert-header {
  position: relative;
  margin: 0 -24px 12px;
  padding: 0 24px 12px;
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}

.base-alert-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.3;
  /* Leave room for the ✕ icon when it's rendered (24px button + gap). */
  padding-right: 32px;
}

.base-alert-close-icon {
  position: absolute;
  top: -4px;
  right: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 8px;
  background: color-mix(in oklab, var(--text) 4%, transparent);
  border: 1px solid transparent;
  opacity: 0.7;
  color: var(--neutral-100);
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    opacity 120ms ease;
}
.base-alert-close-icon:hover {
  opacity: 1;
  background: color-mix(in oklab, var(--neutral-950) 85%, transparent);
  border-color: color-mix(in oklab, var(--neutral-100) 44%, transparent);
}
.base-alert-close-icon:focus-visible {
  outline: 2px solid var(--focus-ring, var(--neutral-50));
  outline-offset: 2px;
}

.base-alert-message-text {
  white-space: pre-line;
}

.base-alert-message-text :deep(strong) {
  color: var(--text);
  font-weight: 600;
}

.base-alert-message-text :deep(.modal-link) {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

.base-alert-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.base-alert-extra {
  margin-top: 12px;
}

.base-alert-detail-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.base-alert-detail-label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.base-alert-detail-recessed {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--neutral-100) 4%, transparent);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
  max-height: 220px;
  overflow-y: auto;
}

.base-alert-detail-item {
  font-size: 13px;
  line-height: 1.45;
  color: var(--neutral-100);
}

.base-alert-detail-item :deep(.modal-link) {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
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
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin: 0 -24px;
  padding: 12px 24px 0;
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}

/* Constrain width + nowrap so two long labels sit side-by-side without
 * stretching to 50/50; they ellipsis past the cap. */
.base-alert-footer > button {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 96px;
  max-width: 240px;
}

/* Warmer destructive red, scoped here because the global `--danger` reads
 * muddy against this panel surface (global token left untouched). */
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
