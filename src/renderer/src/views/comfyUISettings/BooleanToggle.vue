<script setup lang="ts">
import { ref, watch } from 'vue'
import type { DetailField } from '../../types/ipc'

/**
 * macOS Settings-style boolean switch. The parent field row owns the
 * label; this component renders only the switch control on the right.
 */

interface Props {
  field: DetailField
}

const props = defineProps<Props>()

const emit = defineEmits<{
  update: [value: boolean]
}>()

const visualOn = ref(props.field.value === true)

watch(
  () => props.field.value,
  (next) => {
    visualOn.value = next === true
  }
)

function handleClick(): void {
  const next = !visualOn.value
  visualOn.value = next
  emit('update', next)
}
</script>

<template>
  <button
    type="button"
    role="switch"
    class="bt-switch"
    :data-state="visualOn ? 'checked' : 'unchecked'"
    :aria-checked="visualOn"
    :aria-label="field.label"
    @click="handleClick"
  >
    <span class="bt-track" :aria-hidden="true">
      <span class="bt-thumb"></span>
    </span>
  </button>
</template>

<style scoped>
.bt-switch {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
}

.bt-track {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  border-radius: 999px;
  background-color: rgba(120, 120, 128, 0.32);
  transition: background-color 200ms ease;
}

.bt-switch[data-state='checked'] .bt-track {
  background-color: var(--accent-primary);
}

.bt-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.2),
    0 1px 1px rgba(0, 0, 0, 0.08);
  transition: transform 200ms cubic-bezier(0.4, 0, 0.2, 1);
  transform: translateX(0);
}

.bt-switch[data-state='checked'] .bt-thumb {
  transform: translateX(16px);
}

@media (prefers-reduced-motion: reduce) {
  .bt-track,
  .bt-thumb {
    transition-duration: 0ms;
  }
}
</style>
