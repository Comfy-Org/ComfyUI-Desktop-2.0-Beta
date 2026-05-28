<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useModalOverlay } from '../../composables/useModalOverlay'
import { linkify, handleModalLinkClick } from '../../lib/modalLinkify'
import type { ModalDetailGroup } from '../../types/ipc'

/**
 * Reusable alert primitive (shadcn-style). Parent controls `open`;
 * the primitive owns teleport, transition, dismiss behavior, focus
 * capture+restore, body scroll lock, and a11y attrs.
 *
 * Alerts are intentionally compact (title + message + actions)
 * compared to `BaseModal`. Default is a single OK (browser `alert()`
 * semantics). Pass `showCancel` for Cancel + OK (`confirm()` semantics).
 * Use `BaseModal` when you need header/footer slots beyond the
 * primary/secondary/cancel triad.
 *
 * Supports up to **three footer actions** in a fixed order:
 *   `[Cancel] [Secondary] [Primary]`
 * — pass `showCancel` for Cancel, `secondaryLabel` for the middle
 * action. When the footer already has two actions and you still need
 * a dismiss affordance, set `showCloseIcon` so the ✕ in the header
 * carries it (mutually exclusive with `showCancel`).
 *
 * Rich-variant body: pass `messageDetails` for recessed sub-blocks
 * (release notes, change summaries) — gives confirm flows parity with
 * the legacy `ModalDialog.vue` `confirm` renderer without a separate
 * primitive.
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
  /** Optional secondary action (e.g. "Close & Launch" sitting between
   *  Cancel and Primary). Footer renders `[Cancel] [Secondary] [Primary]`
   *  when both are set. Emits `@secondary`. */
  secondaryLabel?: string
  /** Secondary-action visual treatment. Defaults to `'default'`
   *  (neutral). */
  secondaryTone?: 'primary' | 'danger' | 'default'
  /** Render a top-right ✕ in the header that emits `cancel`. Use when
   *  the footer already holds two actions and there's no room for a
   *  Cancel button. Mutually exclusive with `showCancel` (the ✕ is
   *  redundant when there's a Cancel button). Default false. */
  showCloseIcon?: boolean
  /** Recessed sub-blocks rendered below the message (release notes,
   *  change summaries). When present, the panel widens slightly and
   *  enables internal scrolling — same shape `useModal.confirm` /
   *  `useModal.prompt` accept via the `messageDetails` field. */
  messageDetails?: ModalDetailGroup[]
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
  /** Optional `data-testid` override for the secondary button.
   *  Defaults to `'base-alert-secondary'`. */
  testIdSecondary?: string
  /** Optional `data-testid` override for the header ✕ icon.
   *  Defaults to `'base-alert-close-icon'`. */
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

const actionBtnRef = ref<HTMLButtonElement | null>(null)
let returnFocusTo: HTMLElement | null = null
let previousBodyOverflow: string | null = null

const dialogAriaLabel = computed(() => props.ariaLabel)
const dialogAriaLabelledby = computed(
  () => props.ariaLabelledby ?? (props.ariaLabel ? undefined : TITLE_ID)
)

/** ESC + backdrop dismiss. Treat as cancel whenever there is any
 *  cancel affordance (Cancel button OR header ✕) — otherwise treat as
 *  the primary OK (single-action alert semantics). The secondary
 *  action never receives ESC/backdrop dismissal: it's a discrete
 *  third choice, not a fallback. */
function dismiss(): void {
  if (props.showCancel || props.showCloseIcon) emit('cancel')
  else emit('close')
}

const hasDetails = computed(() => props.messageDetails.length > 0)
const linkifiedMessage = computed(() => linkify(props.message))
/** Two-button footer (Cancel+Primary or Secondary+Primary) needs
 *  more horizontal room than the default 400px so labels stay on one
 *  line. Triggered by `secondaryLabel` since that's the only path to
 *  two non-cancel actions. Plain Cancel+Primary already fits at 400px
 *  for typical labels. */
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
            <!-- Appended rich content (e.g. a snapshot diff accordion) that
                 should sit BELOW the message + details without replacing them
                 the way the default slot would. -->
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
  width: min(440px, 100%);
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

/** Rich variant: panel widens slightly + lets the body scroll so
 *  long detail blocks (release notes / change summaries) don't push
 *  the footer off-screen. */
.base-alert-panel--rich {
  width: min(480px, 100%);
  max-height: min(80vh, 640px);
}

/** Two-button-action variant: footer holds two non-cancel actions
 *  (e.g. "Launch Anyway" + "Close & Launch New"). Default 440px
 *  cramps labels — widen to let buttons sit side-by-side on one line. */
.base-alert-panel--wide-actions {
  width: min(520px, 100%);
}

/** Rich + wide-actions takes the larger of the two. */
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

/** Footer buttons size to content with sane min/max bounds — labels
 *  stay on a single line and truncate with an ellipsis past the cap.
 *  Default browser button rendering is fine; we just constrain width
 *  and disable text wrapping so two long labels can sit side-by-side
 *  in the wide-actions panel without stretching to 50/50. */
.base-alert-footer > button {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 96px;
  max-width: 240px;
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
