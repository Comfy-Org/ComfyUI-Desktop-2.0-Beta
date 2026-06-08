<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, X } from 'lucide-vue-next'
import heroUrl from '../assets/first-use/why-cloud-hero.svg'

const emit = defineEmits<{
  close: []
  'try-cloud': []
}>()

const { tm } = useI18n()

const benefits = computed<string[]>(() => {
  const raw = tm('firstUse.whyCloud.benefits')
  return Array.isArray(raw) ? (raw as unknown as string[]) : []
})

const overlayRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)
// Element focused before open; restored on close to return focus to the trigger.
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
  // Focus the dialog container, not the close button — keeps focus trapped for
  // keyboard/AT without painting a focus-visible ring on open.
  void nextTick(() => overlayRef.value?.focus())
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
        class="why-cloud-overlay"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('firstUse.whyCloud.title')"
        tabindex="-1"
        @mousedown="onOverlayMouseDown"
        @click="onOverlayClick"
      >
        <div class="why-cloud-content modal-fade-panel">
          <button
            class="why-cloud-close"
            type="button"
            :aria-label="$t('common.close')"
            data-testid="why-cloud-close"
            @click="emit('close')"
          >
            <X :size="18" />
          </button>
          <div class="why-cloud-grid">
            <img :src="heroUrl" class="why-cloud-image" :alt="$t('firstUse.whyCloud.imageAlt')" />
            <div class="why-cloud-body">
              <div class="why-cloud-body-main">
                <header class="why-cloud-header">
                  <h2 class="why-cloud-title">{{ $t('firstUse.whyCloud.title') }}</h2>
                </header>
                <p class="why-cloud-lead">{{ $t('firstUse.whyCloud.lead') }}</p>
                <ul class="why-cloud-list">
                  <li v-for="b in benefits" :key="b">
                    <Check :size="16" class="why-cloud-check" />
                    <span>{{ b }}</span>
                  </li>
                </ul>
              </div>
              <footer class="why-cloud-footer">
                <button
                  class="brand-ghost why-cloud-maybe"
                  type="button"
                  data-testid="why-cloud-maybe"
                  @click="emit('close')"
                >
                  {{ $t('firstUse.whyCloud.maybeLater') }}
                </button>
                <button
                  class="brand-primary"
                  type="button"
                  data-testid="why-cloud-try"
                  @click="emit('try-cloud')"
                >
                  {{ $t('firstUse.whyCloud.tryCta') }}
                </button>
              </footer>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.why-cloud-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: clamp(72px, 10vh, 132px) clamp(32px, 5vw, 80px) clamp(80px, 11vh, 140px);
  background: color-mix(in oklab, var(--neutral-800) 70%, transparent);
  backdrop-filter: blur(8px) saturate(115%);
  -webkit-backdrop-filter: blur(8px) saturate(115%);
}

.why-cloud-content {
  position: relative;
  display: flex;
  width: min(100%, calc((100vh - clamp(152px, 21vh, 272px)) * (916 / 445)));
  max-width: 100%;
  max-height: 100%;
  aspect-ratio: 916 / 445;
  border-radius: 16px;
  overflow: hidden;
  background: var(--neutral-900);
  border: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
  /* box-shadow: 0 40px 100px 0 rgba(0, 0, 0, 0.45); */
}

.why-cloud-close {
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
  opacity: 0.7;
  color: var(--neutral-100);
  cursor: pointer;
  transition:
    border-color 120ms ease,
    opacity 120ms ease;
}
.why-cloud-close:hover {
  border-color: color-mix(in oklab, var(--neutral-100) 44%, transparent);
  opacity: 1;
}
.why-cloud-close:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.why-cloud-close :deep(svg) {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  stroke: currentColor;
}

.why-cloud-grid {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
  width: 100%;
  height: 100%;
}

.why-cloud-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  display: block;
  background: linear-gradient(135deg, var(--neutral-800) 0%, var(--neutral-900) 100%);
}

.why-cloud-body {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(1.5rem, 2.5vw, 2.5rem);
  overflow: auto;
}
.why-cloud-body-main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: clamp(0.75rem, 1.2vw, 1.25rem);
}

.why-cloud-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.why-cloud-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--takeover-fs-h2);
  font-weight: 800;
  letter-spacing: 0;
  color: var(--neutral-100);
  line-height: 32px;
}
.why-cloud-pill {
  padding: 4px;
  border-radius: 32px;
  background: var(--neutral-100);
  color: var(--neutral-900);
  font-size: var(--takeover-fs-caption);
  font-weight: 600;
  line-height: normal;
  font-family: var(--font-sans);
  text-transform: uppercase;
}
.why-cloud-lead {
  margin: 0;
  font-size: var(--takeover-fs-lead);
  color: var(--neutral-300);
  font-weight: 400;
  font-family: var(--font-sans);
  line-height: normal;
}

.why-cloud-list {
  list-style: none;
  margin: 4px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.why-cloud-list li {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: start;
  gap: 12px;
  font-size: var(--takeover-fs-lead);
  color: var(--neutral-100);
  line-height: normal;
}
.why-cloud-check {
  color: var(--comfy-yellow);
  margin-top: 3px;
}

.why-cloud-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 16px;
  padding-top: clamp(1rem, 1.5vw, 1.5rem);
  border-top: 1px solid color-mix(in oklab, var(--neutral-100) 8%, transparent);
}
</style>
