<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/**
 * Single modal primitive. Replaces the bespoke takeover surfaces.
 *
 * - `binding`: true → no click-outside dismiss, no Esc dismiss. Caller is
 *   responsible for providing an explicit close affordance (back chevron,
 *   cancel button, etc.). Used by install wizards / first-use.
 * - `opacity`: 'dim' | 'heavy-dim' — backdrop strength. No 'opaque' — the
 *   takeover variant is gone.
 * - `width`: 'regular' (~600px) | 'wide' (~900px). No fullscreen.
 *
 * Default slot is the modal body. The component owns backdrop + outer
 * `.view-modal-content` box; the slot can render its own `.view-modal-header`
 * / `.view-modal-body` / `.view-modal-footer` rows as needed.
 */
const props = withDefaults(defineProps<{
  binding?: boolean
  opacity?: 'dim' | 'heavy-dim'
  width?: 'regular' | 'wide'
  /** Extra class(es) appended to the content box. */
  contentClass?: string
}>(), {
  binding: false,
  opacity: 'dim',
  width: 'wide',
  contentClass: '',
})

const emit = defineEmits<{
  close: []
}>()

const overlayRef = ref<HTMLDivElement | null>(null)
const mouseDownOnOverlay = ref(false)

function handleOverlayMouseDown(e: MouseEvent): void {
  mouseDownOnOverlay.value = e.target === overlayRef.value
}

function handleOverlayClick(e: MouseEvent): void {
  if (props.binding) return
  if (e.target === overlayRef.value && mouseDownOnOverlay.value) {
    emit('close')
  }
  mouseDownOnOverlay.value = false
}

function handleKeydown(e: KeyboardEvent): void {
  if (props.binding) return
  if (e.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="overlayRef"
      class="view-modal active"
      :class="{
        'view-modal--heavy-dim': opacity === 'heavy-dim',
      }"
      @mousedown="handleOverlayMouseDown"
      @click="handleOverlayClick"
    >
      <div
        class="view-modal-content"
        :class="[
          { 'view-modal-content--regular': width === 'regular' },
          contentClass,
        ]"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>
