<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

/**
 * Single modal primitive.
 *
 * - `binding`: true → no click-outside / Esc dismiss. Caller provides an
 *   explicit close affordance (back chevron, cancel button). Defaults the
 *   backdrop to `opaque` so the user reads "no escape via X / outside-click".
 * - `opacity`: 'dim' | 'heavy-dim' | 'opaque'.
 * - `width`: 'regular' (~600px) | 'wide' (~900px).
 *
 * Default slot is the body; render `.view-modal-header` / `.view-modal-body` /
 * `.view-modal-footer` rows inside.
 */
type Opacity = 'dim' | 'heavy-dim' | 'opaque'

const props = withDefaults(defineProps<{
  binding?: boolean
  opacity?: Opacity
  width?: 'regular' | 'wide'
  /** Extra class(es) appended to the content box. */
  contentClass?: string
}>(), {
  binding: false,
  opacity: undefined,
  width: 'wide',
  contentClass: '',
})

const resolvedOpacity = computed<Opacity>(() => props.opacity ?? (props.binding ? 'opaque' : 'dim'))

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
        'view-modal--heavy-dim': resolvedOpacity === 'heavy-dim',
        'view-modal--opaque': resolvedOpacity === 'opaque',
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
