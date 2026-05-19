<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DetailField } from '../../types/ipc'

/**
 * Boolean toggle for the ComfyUI Settings drawer. Modeled on shadcn's
 * Switch: `data-state` attribute drives all visual state, thumb is a
 * real child element transitioned via `translate-x`.
 *
 * Owns a local `visualOn` ref so the click is optimistic — `updateField`
 * in the parent awaits an IPC roundtrip + section reload, so without
 * this the visible state would snap to its destination only after the
 * roundtrip and the CSS transition would never have a chance to play.
 * The watcher reconciles back to `field.value` (no-op on success, snap
 * on failure / external change).
 */

interface Props {
  field: DetailField
}

const props = defineProps<Props>()

const emit = defineEmits<{
  update: [value: boolean]
}>()

const { t } = useI18n()

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
    <span class="bt-label">{{ t('comfyUISettings.toggleOn', 'Enabled') }}</span>
  </button>
</template>

<style scoped>
.bt-switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  background: var(--surface);
  border: none;
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.bt-track {
  flex-shrink: 0;
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
