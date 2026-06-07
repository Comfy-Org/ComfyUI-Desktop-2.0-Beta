<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from './ui/BaseModal.vue'
import { emitTelemetryAction } from '../lib/telemetry'

// Send Feedback modal wrapping the typeform in an iframe. The iframe origin
// must stay whitelisted in panel.html's `frame-src` CSP directive. On submit
// (detected via the typeform postMessage protocol) we wait 2s, then auto-close.

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
  // Match any `*-submit` variant: typeform's event names have changed across
  // SDK versions but always include `submit`.
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
/* The typeform page is dark, so let the BaseModal's default dark chrome
 * show through — the previous white override left the close X invisible
 * against the dark form. Only the body padding override remains so the
 * iframe sits flush against the panel edge. */
:global(.base-modal-panel.feedback-modal-panel) {
  min-height: 0;
}
:global(.feedback-modal-panel .base-modal-body) {
  padding: 0;
  overflow: hidden;
}

.feedback-modal-body {
  position: relative;
  width: 100%;
  height: clamp(520px, 76vh, 820px);
  overflow: hidden;
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
  color: color-mix(in oklab, var(--neutral-100, #fff) 65%, transparent);
  pointer-events: none;
}
</style>
