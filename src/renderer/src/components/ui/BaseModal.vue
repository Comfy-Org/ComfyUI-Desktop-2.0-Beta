<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useModalOverlay } from '../../composables/useModalOverlay'

/**
 * Reusable modal primitive (shadcn-style). Parent controls `open`;
 * the primitive owns teleport, transition, dismiss behavior, focus
 * capture+restore, body scroll lock, and a11y attrs so consumers can't
 * forget any of them.
 *
 * One of `aria-label` / `aria-labelledby` is required — the primitive
 * is the modal element for assistive tech, so it must always have an
 * accessible name. We warn loudly in dev rather than throwing so a
 * mis-wired modal still renders in prod.
 *
 * Sits at z-index 60 to match `TermsModal` / `WhyTryCloudModal` (below
 * context menus, above the settings drawer). Migration of those modals
 * onto this primitive is a follow-up (TODO(modal-migration)).
 */

type Size = 'sm' | 'md' | 'lg' | 'xl'

interface Props {
  open: boolean
  size?: Size
  ariaLabel?: string
  ariaLabelledby?: string
  /** Dismiss when Escape is pressed. Default true. */
  dismissOnEscape?: boolean
  /** Dismiss when the backdrop is clicked. Default true. */
  dismissOnOutside?: boolean
  /** Render a top-right ✕ close affordance inside the panel. Default true. */
  showCloseButton?: boolean
  /** Lock body scroll while open. Default true. */
  preventScroll?: boolean
  /** Optional class hook on the inner panel for consumer-specific overrides. */
  contentClass?: string | string[] | Record<string, boolean>
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  ariaLabel: undefined,
  ariaLabelledby: undefined,
  dismissOnEscape: true,
  dismissOnOutside: true,
  showCloseButton: true,
  preventScroll: true,
  contentClass: undefined
})

const emit = defineEmits<{ close: [] }>()

if (!props.ariaLabel && !props.ariaLabelledby) {
  console.warn(
    '[BaseModal] requires `aria-label` or `aria-labelledby` — modal has no accessible name.'
  )
}

const closeBtnRef = ref<HTMLButtonElement | null>(null)
/** Pre-mount focus owner; restored on close so keyboard users return
 *  to the trigger (matches `TermsModal`'s pattern). */
let returnFocusTo: HTMLElement | null = null
/** Snapshot of the body's prior `overflow` so unmount restores any
 *  value the host page had set rather than clobbering it to empty. */
let previousBodyOverflow: string | null = null

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  // ESC fires through the composable's keydown listener; the closure
  // re-checks the dismiss-on-escape prop so a same-tick flip still wins.
  () => props.open && props.dismissOnEscape,
  () => emit('close')
)

function onOverlayMouseDown(e: MouseEvent) {
  if (!props.dismissOnOutside) return
  handleOverlayMouseDown(e)
}
function onOverlayClick(e: MouseEvent) {
  if (!props.dismissOnOutside) return
  handleOverlayClick(e)
}

function onCloseClick(): void {
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
  void nextTick(() => closeBtnRef.value?.focus())
}

function restoreFocus(): void {
  // The original trigger may have been removed from the DOM while the
  // modal was open (rare but possible with dynamic lists).
  try {
    returnFocusTo?.focus()
  } catch {
    /* original trigger detached — nothing to restore to */
  }
  returnFocusTo = null
}

// Open / close lifecycle: the Transition handles fade-out, but focus
// and scroll-lock have to flip synchronously here so they don't leak
// past dismiss or overlap an immediate re-open.
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
  // Defensive: parent v-if-unmounted us while still open. Don't leave
  // the body locked or focus stranded.
  unlockBodyScroll()
  restoreFocus()
})

const sizeClass = computed(() => `is-size-${props.size}`)
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade" appear>
      <div
        v-if="open"
        class="base-modal-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="ariaLabel"
        :aria-labelledby="ariaLabelledby"
        @mousedown="onOverlayMouseDown"
        @click="onOverlayClick"
      >
        <div class="base-modal-panel modal-fade-panel" :class="[sizeClass, contentClass]">
          <button
            v-if="showCloseButton"
            ref="closeBtnRef"
            type="button"
            class="base-modal-close"
            :aria-label="$t('common.close')"
            data-testid="base-modal-close"
            @click="onCloseClick"
          >
            <X :size="18" />
          </button>
          <header v-if="$slots.header" class="base-modal-header">
            <slot name="header" />
          </header>
          <div class="base-modal-body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="base-modal-footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.base-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: clamp(32px, 6vh, 72px) clamp(16px, 4vw, 48px);
  background: color-mix(in oklab, var(--neutral-800) 70%, transparent);
}

.base-modal-panel {
  --base-modal-width-sm: 480px;
  --base-modal-width-md: 640px;
  --base-modal-width-lg: 800px;
  --base-modal-width-xl: min(1080px, 92vw);

  position: relative;
  display: flex;
  flex-direction: column;
  width: var(--base-modal-width, var(--base-modal-width-md));
  max-width: 100%;
  min-height: clamp(360px, 50vh, 540px);
  max-height: clamp(360px, 80vh, 920px);
  border-radius: 14px;
  overflow: hidden;
  background: var(--modal-surface-bg);
  border: 1px solid var(--modal-surface-border);
  box-shadow: var(--modal-surface-shadow);
  color: var(--neutral-100);
}
.base-modal-panel.is-size-sm {
  --base-modal-width: var(--base-modal-width-sm);
}
.base-modal-panel.is-size-md {
  --base-modal-width: var(--base-modal-width-md);
}
.base-modal-panel.is-size-lg {
  --base-modal-width: var(--base-modal-width-lg);
}
.base-modal-panel.is-size-xl {
  --base-modal-width: var(--base-modal-width-xl);
}

.base-modal-close {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
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
.base-modal-close:hover {
  opacity: 1;
  background: color-mix(in oklab, var(--neutral-950) 85%, transparent);
  border-color: color-mix(in oklab, var(--neutral-100) 44%, transparent);
}
.base-modal-close:focus-visible {
  outline: 2px solid var(--focus-ring, var(--neutral-50));
  outline-offset: 2px;
}

.base-modal-header {
  padding: 20px 56px 12px 24px;
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}

.base-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px;
}

.base-modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 24px 16px;
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}
</style>
