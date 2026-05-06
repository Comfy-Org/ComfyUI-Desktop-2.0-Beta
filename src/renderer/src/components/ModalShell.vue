<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Modal from './Modal.vue'

/**
 * Shared chrome for every modal: standard header (title + close) and
 * scrollable body, all sized by the unified `.view-modal-content` rules.
 *
 * Wraps `Modal.vue` and forwards its sizing/backdrop props. Use slots
 * to override individual rows:
 *   - `#header` — replace the entire header row (e.g. takeovers
 *     mounting `TakeoverBack` + `TakeoverHeader`).
 *   - `#title` — replace just the title content (e.g. DetailModal's
 *     contenteditable name).
 *   - default — the body content.
 *   - `#footer` — pinned `view-modal-footer` row (ProgressModal,
 *     ConsoleModal, action bars).
 */

type Opacity = 'dim' | 'heavy-dim' | 'opaque'

withDefaults(defineProps<{
  binding?: boolean
  opacity?: Opacity
  width?: 'regular' | 'wide'
  contentClass?: string
  inline?: boolean
  /** Plain text title shown in the default header. Ignored if a `#header` slot is provided. */
  title?: string
  /** Hide the corner close button (binding takeovers without an in-header dismiss). */
  hideClose?: boolean
  /** Glyph for the corner close (defaults to ✕; ProgressModal/ConsoleModal swap to − while running). */
  closeGlyph?: string
}>(), {
  binding: false,
  opacity: undefined,
  width: 'wide',
  contentClass: '',
  inline: false,
  title: '',
  hideClose: false,
  closeGlyph: '✕',
})

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
</script>

<template>
  <Modal
    :binding="binding"
    :opacity="opacity"
    :width="width"
    :content-class="contentClass"
    :inline="inline"
    @close="emit('close')"
  >
    <div class="view-modal-header">
      <slot name="header">
        <div class="view-modal-title">
          <slot name="title">{{ title }}</slot>
        </div>
        <button
          v-if="!hideClose"
          class="view-modal-close"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >{{ closeGlyph }}</button>
      </slot>
    </div>
    <div class="view-modal-body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="view-modal-footer">
      <slot name="footer" />
    </div>
  </Modal>
</template>
