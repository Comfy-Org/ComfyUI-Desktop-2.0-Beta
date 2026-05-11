<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'

/**
 * System-modal popup shell.
 *
 * Renders a single confirm dialog (title + message + cancel/confirm
 * buttons) over a translucent blurred backdrop covering the full host
 * window. Click-outside or Escape acks `cancel`; Enter (or the confirm
 * button) acks `confirm`.
 *
 * Spec arrives via the `comfy-systemmodal:set-modal` IPC each time
 * main opens the modal — the view is hidden between opens but the
 * webContents persists, so the bridge listener is registered once at
 * mount and stays alive.
 */

type SystemModalConfirmStyle = 'primary' | 'danger'

interface SystemModalSpec {
  id: string
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  confirmStyle?: SystemModalConfirmStyle
  theme: { bg: string; text: string }
}

interface Bridge {
  action(payload: { modalId: string; action: 'confirm' | 'cancel' }): void
  ready(): void
  notifyRendered(): void
  onModal(cb: (spec: SystemModalSpec) => void): () => void
}

const bridge = (window as unknown as { __comfySystemModal?: Bridge }).__comfySystemModal

const spec = ref<SystemModalSpec | null>(null)
const themeBg = ref<string>('#262729')
const themeText = ref<string>('#dddddd')
const confirmBtnRef = ref<HTMLButtonElement | null>(null)

const confirmStyle = computed<SystemModalConfirmStyle>(
  () => spec.value?.confirmStyle ?? 'primary',
)

/** Body-luminance test — drives is-light styling, matching the
 *  convention in TitleBarApp.vue / TitlePopupApp.vue. */
const isLight = computed(() => {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return false
  ctx.fillStyle = themeBg.value
  const hex = ctx.fillStyle as string
  if (!hex.startsWith('#') || hex.length < 7) return false
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128
})

function ack(action: 'confirm' | 'cancel'): void {
  const current = spec.value
  if (!current) return
  bridge?.action({ modalId: current.id, action })
}

function onBackdropMouseDown(event: MouseEvent): void {
  // Only ack cancel on a true click on the backdrop (not on the
  // modal box). MouseDown rather than click so a drag-out from inside
  // the box doesn't cancel.
  if (event.target === event.currentTarget) {
    ack('cancel')
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (!spec.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    ack('cancel')
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    ack('confirm')
  }
}

let unsubModal: (() => void) | undefined

/** Sequence guard — only the rAF closure for the most recently
 *  applied modal gets to fire `notifyRendered`. Stale rAFs from
 *  earlier opens are suppressed so main never receives a "rendered"
 *  ack for a modal it has already replaced. */
let renderSeq = 0

onMounted(() => {
  unsubModal = bridge?.onModal((next) => {
    spec.value = next
    themeBg.value = next.theme.bg
    themeText.value = next.theme.text
    const seq = ++renderSeq
    // `nextTick` alone is enough — Vue flushes the DOM update
    // synchronously in the microtask, and the browser paints that DOM
    // in the same frame it's shown by main, so notifying immediately
    // (no rAF wait) avoids one frame of perceived delay between click
    // and visible modal.
    void nextTick(() => {
      if (seq !== renderSeq) return
      // Focus the confirm button so Enter / Space activates it
      // without the user having to tab into the modal first.
      confirmBtnRef.value?.focus()
      bridge?.notifyRendered()
    })
  })
  window.addEventListener('keydown', onKeydown)
  bridge?.ready()
})

onUnmounted(() => {
  unsubModal?.()
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div
    v-if="spec"
    class="backdrop"
    :class="{ 'is-light': isLight }"
    @mousedown="onBackdropMouseDown"
  >
    <div
      class="card"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`sysmodal-title-${spec.id}`"
      :style="{ background: themeBg, color: themeText }"
    >
      <h2
        :id="`sysmodal-title-${spec.id}`"
        class="title"
      >
        {{ spec.title }}
      </h2>
      <p class="message">{{ spec.message }}</p>
      <div class="actions">
        <button
          type="button"
          class="btn btn-cancel"
          @click="ack('cancel')"
        >
          {{ spec.cancelLabel }}
        </button>
        <button
          ref="confirmBtnRef"
          type="button"
          class="btn"
          :class="`btn-${confirmStyle}`"
          @click="ack('confirm')"
        >
          {{ spec.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  margin: 0;
  width: 100%;
  height: 100%;
  background: transparent !important;
}

.backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* Translucent dim + blur of whatever lies underneath. The
     WebContentsView itself is per-pixel transparent, so this layer is
     what the user actually sees behind the card. */
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font: 13px/1.4 var(--font-sans, 'Inter', system-ui, sans-serif);
  user-select: none;
}
.backdrop.is-light {
  background: rgba(255, 255, 255, 0.35);
}

.card {
  min-width: 320px;
  max-width: min(440px, calc(100vw - 48px));
  border: 1px solid var(--border, #494a50);
  border-radius: 8px;
  padding: 18px 20px 16px;
  box-shadow:
    0 8px 28px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.2);
}

.title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}

.message {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.9;
  white-space: pre-wrap;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 80px;
  padding: 6px 14px;
  border-radius: 5px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: filter 0.08s, background-color 0.08s;
}
.btn:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 1px;
}

.btn-cancel {
  background: transparent;
  color: inherit;
  border-color: var(--border, rgba(127, 127, 127, 0.4));
}
.btn-cancel:hover {
  background: rgba(127, 127, 127, 0.12);
}

.btn-primary {
  background: var(--accent, #3b82f6);
  color: #fff;
}
.btn-primary:hover {
  filter: brightness(1.08);
}

.btn-danger {
  background: #ef4444;
  color: #fff;
}
.btn-danger:hover {
  filter: brightness(1.08);
}
</style>
