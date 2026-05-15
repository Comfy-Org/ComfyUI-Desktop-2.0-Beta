<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { X } from 'lucide-vue-next'
import InlineRichText from './InlineRichText.vue'
import { PRIVACY_POLICY } from '../lib/privacyPolicy'

const emit = defineEmits<{
  close: []
}>()

const policy = PRIVACY_POLICY

const overlayRef = ref<HTMLDivElement | null>(null)
const closeBtnRef = ref<HTMLButtonElement | null>(null)
const mouseDownOnOverlay = ref(false)
/** Element that owned focus before the modal opened. Captured on mount
 *  so close (any path: ESC, ✕, overlay click) can restore focus to the
 *  original trigger. */
let returnFocusTo: HTMLElement | null = null

function onOverlayMouseDown(e: MouseEvent) {
  mouseDownOnOverlay.value = e.target === overlayRef.value
}
function onOverlayClick(e: MouseEvent) {
  if (e.target === overlayRef.value && mouseDownOnOverlay.value) emit('close')
  mouseDownOnOverlay.value = false
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => closeBtnRef.value?.focus())
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  returnFocusTo?.focus()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="modal-fade" appear>
      <div
        ref="overlayRef"
        class="terms-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('firstUse.termsModalTitle')"
        @mousedown="onOverlayMouseDown"
        @click="onOverlayClick"
      >
        <div class="terms-content modal-fade-panel">
          <button
            ref="closeBtnRef"
            class="terms-close"
            type="button"
            :aria-label="$t('common.close')"
            data-testid="terms-modal-close"
            @click="emit('close')"
          >
            <X :size="18" />
          </button>
          <header class="terms-header">
            <h2 class="terms-title">{{ $t('firstUse.termsModalTitle') }}</h2>
            <div class="terms-meta">
              <span
                ><strong>{{ $t('firstUse.privacyPolicyEffective') }}:</strong>
                {{ policy.effectiveDate }}</span
              >
              <span
                ><strong>{{ $t('firstUse.privacyPolicyAppliesTo') }}:</strong>
                {{ policy.appliesTo }}</span
              >
            </div>
          </header>
          <div class="terms-body" tabindex="0">
            <template v-for="(block, i) in policy.blocks" :key="i">
              <h2 v-if="block.kind === 'h2'" class="terms-h2">{{ block.text }}</h2>
              <h3 v-else-if="block.kind === 'h3'" class="terms-h3">{{ block.text }}</h3>
              <p v-else-if="block.kind === 'p' && block.text" class="terms-p">
                <InlineRichText :text="block.text" />
              </p>
              <ul v-else-if="block.kind === 'ul' && block.items" class="terms-ul">
                <li v-for="(item, k) in block.items" :key="k">
                  <InlineRichText :text="item" />
                </li>
              </ul>
            </template>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.terms-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: clamp(48px, 8vh, 96px) clamp(24px, 5vw, 64px);
}

.terms-content {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(100%, 720px);
  max-height: 100%;
  border-radius: 14px;
  overflow: hidden;
  background: var(--neutral-900);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 6%, transparent);
  box-shadow: 0 24px 64px 0 rgba(0, 0, 0, 0.35);
}

.terms-close {
  position: absolute;
  top: 16px;
  right: 16px;
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
.terms-close:hover {
  opacity: 1;
  background: color-mix(in oklab, var(--neutral-950) 85%, transparent);
  border-color: color-mix(in oklab, var(--neutral-100) 44%, transparent);
}
.terms-close:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.terms-header {
  padding: clamp(1.25rem, 2.5vw, 2rem) clamp(1.5rem, 3vw, 2.25rem) 1rem;
  border-bottom: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}
.terms-title {
  margin: 0 0 8px 0;
  font-family: var(--font-display);
  font-size: var(--takeover-fs-h3);
  font-weight: 800;
  letter-spacing: 0;
  color: var(--neutral-100);
}
.terms-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: var(--takeover-fs-caption);
  color: var(--neutral-300);
}
.terms-meta strong {
  color: var(--neutral-100);
  font-weight: 600;
}

.terms-body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 1.25rem clamp(1.5rem, 3vw, 2.25rem) clamp(1.5rem, 3vw, 2.25rem);
  user-select: text;
  font-size: var(--takeover-fs-body);
  line-height: 1.6;
  color: var(--neutral-300);
}
.terms-body:focus {
  outline: none;
}

.terms-h2 {
  font-size: var(--takeover-fs-lead);
  font-weight: 600;
  margin: 18px 0 8px 0;
  color: var(--neutral-100);
}
.terms-h2:first-child {
  margin-top: 0;
}
.terms-h3 {
  font-size: var(--takeover-fs-body);
  font-weight: 600;
  margin: 14px 0 6px 0;
  color: var(--neutral-100);
}
.terms-p {
  margin: 0 0 10px 0;
}
.terms-ul {
  margin: 0 0 10px 0;
  padding-left: 20px;
}
.terms-ul li {
  margin-bottom: 6px;
}
.terms-body :deep(strong) {
  color: var(--neutral-100);
  font-weight: 600;
}
</style>
