<script setup lang="ts">
// Back affordance for binding takeover-modals: a chevron + label that
// emits `back`, which the host modal wires to its `close` emit.
import { ChevronLeft } from 'lucide-vue-next'

defineProps<{
  /** Visible label sat next to the chevron (e.g. "Back to Dashboard"). */
  label: string
}>()

const emit = defineEmits<{
  back: []
}>()
</script>

<template>
  <button
    type="button"
    class="takeover-back"
    :title="label"
    :aria-label="label"
    @click="emit('back')"
  >
    <ChevronLeft :size="18" class="takeover-back-icon" aria-hidden="true" />
    <span class="takeover-back-label">{{ label }}</span>
  </button>
</template>

<style scoped>
.takeover-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px 4px 6px;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.2;
  flex-shrink: 0;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.takeover-back:hover {
  color: var(--text);
  background: var(--surface-hover, rgba(127, 127, 127, 0.08));
  border-color: var(--border-strong, var(--border));
}

.takeover-back:focus-visible {
  outline: 2px solid var(--accent, #60a5fa);
  outline-offset: 2px;
}

.takeover-back-icon {
  flex-shrink: 0;
}

.takeover-back-label {
  white-space: nowrap;
}
</style>
