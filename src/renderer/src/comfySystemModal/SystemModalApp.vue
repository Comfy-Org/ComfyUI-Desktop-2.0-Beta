<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'
import BaseAlert from '../components/ui/BaseAlert.vue'

/**
 * System-modal popup shell. Renders a confirm dialog via the shared `BaseAlert` so
 * chrome matches the rest of the app's confirms. The spec arrives via
 * `comfy-systemmodal:set-modal` on each open; the webContents persists between opens,
 * so the bridge listener is registered once at mount. `spec.theme` is kept for IPC
 * contract stability but ignored here.
 */

type SystemModalConfirmStyle = 'primary' | 'danger'
type SystemModalSecondaryStyle = 'primary' | 'danger' | 'default'
type SystemModalAction = 'confirm' | 'cancel' | 'secondary'

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
  secondaryLabel?: string
  secondaryStyle?: SystemModalSecondaryStyle
  theme: { bg: string; text: string }
}

interface Bridge {
  action(payload: { modalId: string; action: SystemModalAction }): void
  ready(): void
  notifyRendered(): void
  onModal(cb: (spec: SystemModalSpec) => void): () => void
}

const bridge = (window as unknown as { __comfySystemModal?: Bridge }).__comfySystemModal

const spec = ref<SystemModalSpec | null>(null)

const tone = computed<'primary' | 'danger'>(() =>
  spec.value?.confirmStyle === 'danger' ? 'danger' : 'primary',
)

function ack(action: SystemModalAction): void {
  const current = spec.value
  if (!current) return
  bridge?.action({ modalId: current.id, action })
}

let unsubModal: (() => void) | undefined

/** Only the most recent modal's tick fires `notifyRendered`, suppressing stale acks. */
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
    :secondary-label="spec?.secondaryLabel"
    :secondary-tone="spec?.secondaryStyle ?? 'default'"
    show-cancel
    @close="ack('confirm')"
    @cancel="ack('cancel')"
    @secondary="ack('secondary')"
  >
    <!-- When the spec carries `details`, render `message` then each group as a bulleted list. -->
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
/* Keep the document transparent so only the BaseAlert backdrop + panel paint. */
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
