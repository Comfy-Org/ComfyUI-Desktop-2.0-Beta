<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'
import BaseAlert from '../components/ui/BaseAlert.vue'

/**
 * System-modal popup shell.
 *
 * Renders a confirm dialog over a transparent WebContentsView via the
 * shared `BaseAlert` primitive so chrome matches the rest of the app's
 * confirms (delete, return-to-dashboard, etc.) — same `--neutral-800`
 * panel, hairline separators, brand-yellow CTA, focus capture+restore,
 * ESC + backdrop dismiss.
 *
 * Spec arrives via the `comfy-systemmodal:set-modal` IPC each time
 * main opens the modal; the view is hidden between opens but the
 * webContents persists, so the bridge listener is registered once at
 * mount and stays alive. `theme.*` on the spec is no longer used — the
 * field is kept for IPC contract stability but ignored here.
 */

type SystemModalConfirmStyle = 'primary' | 'danger'

interface SystemModalDetailGroup {
  label: string
  items: string[]
}

interface SystemModalSpec {
  id: string
  title: string
  message: string
  details?: SystemModalDetailGroup[]
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

const tone = computed<'primary' | 'danger'>(() =>
  spec.value?.confirmStyle === 'danger' ? 'danger' : 'primary',
)

function ack(action: 'confirm' | 'cancel'): void {
  const current = spec.value
  if (!current) return
  bridge?.action({ modalId: current.id, action })
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
    const seq = ++renderSeq
    void nextTick(() => {
      if (seq !== renderSeq) return
      bridge?.notifyRendered()
    })
  })
  bridge?.ready()
})

onUnmounted(() => {
  unsubModal?.()
})
</script>

<template>
  <BaseAlert
    :open="!!spec"
    :title="spec?.title ?? ''"
    :message="spec?.message ?? ''"
    :button-label="spec?.confirmLabel ?? ''"
    :cancel-label="spec?.cancelLabel ?? ''"
    :tone="tone"
    show-cancel
    @close="ack('confirm')"
    @cancel="ack('cancel')"
  >
    <!-- Default slot replaces the bare message rendering when the spec
         carries structured `details` — we render `message` first, then
         each detail group as a labelled bulleted list. -->
    <template v-if="spec?.details && spec.details.length > 0" #default>
      <p v-if="spec.message" class="system-modal-message">{{ spec.message }}</p>
      <div
        v-for="(group, gi) in spec.details"
        :key="`detail-${gi}`"
        class="system-modal-detail-group"
      >
        <p class="system-modal-detail-label">{{ group.label }}</p>
        <ul class="system-modal-detail-items">
          <li v-for="(item, ii) in group.items" :key="`item-${ii}`">{{ item }}</li>
        </ul>
      </div>
    </template>
  </BaseAlert>
</template>

<style>
/* WebContentsView is per-pixel transparent — keep the document chrome
   transparent too so only the BaseAlert backdrop + panel paint. */
html,
body,
#app {
  margin: 0;
  width: 100%;
  height: 100%;
  background: transparent !important;
}

.system-modal-message {
  margin: 0 0 12px;
}

.system-modal-detail-group + .system-modal-detail-group {
  margin-top: 10px;
}

.system-modal-detail-label {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.system-modal-detail-items {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--neutral-100);
}

.system-modal-detail-items li {
  line-height: 1.5;
}
</style>
