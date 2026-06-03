<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from './ui/BaseModal.vue'
import { emitTelemetryAction } from '../lib/telemetry'

/**
 * Send Feedback modal — wraps the typeform in an in-app iframe so
 * the user never leaves the desktop window. The iframe origin is
 * whitelisted in `panel.html`'s `frame-src` CSP directive.
 *
 * Submission detection: typeform's embed protocol posts a
 * `{ type: 'form-submit' }` message from `https://form.typeform.com`
 * when the form is submitted. Typeform's own page renders the
 * thank-you screen; we just wait 2s so the user reads it, then close
 * the modal automatically so they're not stuck dismissing it.
 */

const TYPEFORM_ORIGIN = 'https://form.typeform.com'
const AUTOCLOSE_MS = 2000

const props = defineProps<{
  open: boolean
  url: string
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const loading = ref(true)
const submitted = ref(false)
let autocloseTimer: ReturnType<typeof setTimeout> | null = null

function clearAutoclose(): void {
  if (autocloseTimer != null) {
    clearTimeout(autocloseTimer)
    autocloseTimer = null
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      loading.value = true
      submitted.value = false
    } else {
      clearAutoclose()
    }
  }
)

function onFrameLoad(): void {
  loading.value = false
}

function onClose(): void {
  clearAutoclose()
  emit('close')
}

function handleTypeformMessage(event: MessageEvent): void {
  if (event.origin !== TYPEFORM_ORIGIN) return
  if (!props.open || submitted.value) return
  const data = event.data as { type?: string } | string | null
  const type = typeof data === 'string' ? data : data?.type
  // Typeform's embed protocol emits `form-submit` on completion. We
  // accept any `*-submit` variant defensively — their event names
  // have changed across SDK versions (`embed-auto-close-thank-you-screen`,
  // `form-submit`) but always include `submit`.
  if (typeof type !== 'string' || !type.toLowerCase().includes('submit')) return
  submitted.value = true
  emitTelemetryAction('comfy.desktop.feedback.submitted', {})
  autocloseTimer = setTimeout(() => {
    autocloseTimer = null
    emit('close')
  }, AUTOCLOSE_MS)
}

onMounted(() => {
  window.addEventListener('message', handleTypeformMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', handleTypeformMessage)
  clearAutoclose()
})
</script>

<template>
  <BaseModal
    :open="open"
    size="xl"
    :aria-label="t('feedback.modalLabel', 'Send Feedback')"
    content-class="feedback-modal-panel"
    @close="onClose"
  >
    <div class="feedback-modal-body">
      <div v-if="loading" class="feedback-modal-loading" role="status" aria-live="polite">
        {{ t('feedback.loading', 'Loading feedback form…') }}
      </div>
      <iframe
        v-if="open && url"
        class="feedback-modal-frame"
        :src="url"
        :title="t('feedback.modalLabel', 'Send Feedback')"
        loading="eager"
        allow="camera; microphone; autoplay; encrypted-media; fullscreen"
        @load="onFrameLoad"
      />
    </div>
  </BaseModal>
</template>

<style scoped>
/* The typeform page is white — the default BaseModal border + dark
 * surface bg + the close button's translucent chip would all show as
 * a coloured frame around the white form. Repaint the panel for this
 * consumer; the backdrop already separates the modal from the page. */
:global(.base-modal-panel.feedback-modal-panel) {
  background: #ffffff;
  border-color: transparent;
  min-height: 0;
}
:global(.feedback-modal-panel .base-modal-body) {
  padding: 0;
  overflow: hidden;
}
:global(.feedback-modal-panel .base-modal-close) {
  background: transparent;
  border-color: transparent;
  color: var(--neutral-900, #111);
  opacity: 0.55;
}
:global(.feedback-modal-panel .base-modal-close:hover) {
  background: color-mix(in oklab, #000 8%, transparent);
  opacity: 1;
}

.feedback-modal-body {
  position: relative;
  width: 100%;
  height: clamp(520px, 76vh, 820px);
  overflow: hidden;
  background: #ffffff;
}

.feedback-modal-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
}

.feedback-modal-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
  color: color-mix(in oklab, #000 55%, transparent);
  pointer-events: none;
}
</style>
