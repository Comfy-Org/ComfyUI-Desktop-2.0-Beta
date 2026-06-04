<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import Modal from './Modal.vue'

/**
 * Shared modal chrome (header + scrollable body) wrapping `Modal.vue` and
 * forwarding its sizing/backdrop props. Slots: `#header` (whole header row),
 * `#title` (title content only), default (body), `#footer` (pinned footer row).
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
