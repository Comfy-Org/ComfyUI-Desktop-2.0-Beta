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
 * - `inline`: true → render the content frame only (no Teleport, no
 *   backdrop, no Esc handling). Used when the same component renders
 *   embedded in a panel body (e.g. DetailModal in the install-settings
 *   panel) instead of as an overlay. The slot still goes inside a
 *   `view-modal-content view-modal-inline` div so the inner header /
 *   body / footer layout stays identical between modes.
 */
type Opacity = 'dim' | 'heavy-dim' | 'opaque'

const props = withDefaults(defineProps<{
  binding?: boolean
  opacity?: Opacity
  width?: 'regular' | 'wide'
  /** Extra class(es) appended to the content box. */
  contentClass?: string
  /** Render content frame only (no overlay/backdrop/dismiss). */
  inline?: boolean
}>(), {
  binding: false,
  opacity: undefined,
  width: 'wide',
  contentClass: '',
  inline: false,
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
  if (props.binding || props.inline) return
  if (e.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  if (!props.inline) document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  if (!props.inline) document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- Inline mode: no Teleport, no backdrop. The host panel positions
       this; the content keeps its standard header/body/footer layout. -->
  <div
    v-if="inline"
    class="view-modal-content view-modal-inline"
    :class="contentClass"
  >
    <slot />
  </div>
  <Teleport v-else to="body">
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
