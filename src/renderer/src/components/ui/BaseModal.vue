<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useModalOverlay } from '../../composables/useModalOverlay'

// Reusable modal primitive. Owns teleport, dismiss, focus capture/restore,
// body scroll lock, and a11y attrs. One of aria-label / aria-labelledby is
// required (it is the modal element for assistive tech).

type Size = 'sm' | 'md' | 'lg' | 'xl'

interface Props {
  open: boolean
  size?: Size
  ariaLabel?: string
  ariaLabelledby?: string
  dismissOnEscape?: boolean
  dismissOnOutside?: boolean
  showCloseButton?: boolean
  preventScroll?: boolean
  /** Opt-in: backdrop-filter is GPU-bound and costly on Electron. */
  blurOverlay?: boolean
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
  blurOverlay: false,
  contentClass: undefined
})

const emit = defineEmits<{ close: [] }>()

if (!props.ariaLabel && !props.ariaLabelledby) {
  console.warn(
    '[BaseModal] requires `aria-label` or `aria-labelledby` — modal has no accessible name.'
  )
}

const dialogRef = ref<HTMLElement | null>(null)
// Pre-open focus owner, restored on close so focus returns to the trigger.
let returnFocusTo: HTMLElement | null = null
// Prior body `overflow`, restored so we don't clobber a host-set value.
let previousBodyOverflow: string | null = null

const { handleOverlayMouseDown, handleOverlayClick } = useModalOverlay(
  // Re-checks the prop so a same-tick dismiss flip still wins.
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
  // Focus the dialog container, not the close button — keeps focus trapped for
  // keyboard/AT without painting a focus-visible ring on open.
  void nextTick(() => dialogRef.value?.focus())
}

function restoreFocus(): void {
  try {
    returnFocusTo?.focus()
  } catch {
    // Original trigger may have been removed from the DOM while open.
  }
  returnFocusTo = null
}

// Focus + scroll-lock flip synchronously (not via the Transition) so they
// don't leak past dismiss or overlap an immediate re-open.
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
  // Defensive: parent may unmount us while still open.
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
        ref="dialogRef"
        class="base-modal-overlay"
        :class="{ 'base-modal-overlay--blur': blurOverlay }"
        role="dialog"
        aria-modal="true"
        :aria-label="ariaLabel"
        :aria-labelledby="ariaLabelledby"
        tabindex="-1"
        @mousedown="onOverlayMouseDown"
        @click="onOverlayClick"
      >
        <div class="base-modal-panel modal-fade-panel" :class="[sizeClass, contentClass]">
          <button
            v-if="showCloseButton"
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
.base-modal-overlay--blur {
  backdrop-filter: blur(8px) saturate(115%);
  -webkit-backdrop-filter: blur(8px) saturate(115%);
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
  /* Small dialogs hug their content instead of the tall shared min-height. */
  min-height: auto;
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
