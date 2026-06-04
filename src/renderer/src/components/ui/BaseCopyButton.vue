<script setup lang="ts">
// Icon button that copies `value` (or `getValue()`) to the clipboard,
// swapping Copy → Check briefly on success. Use `getValue` for lazy strings.
import { ref, computed, onBeforeUnmount } from 'vue'
import { Copy, Check } from 'lucide-vue-next'

interface Props {
  value?: string
  getValue?: () => string
  size?: number
  ariaLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  value: undefined,
  getValue: undefined,
  size: 14,
  ariaLabel: 'Copy to clipboard',
})

const copied = ref(false)
const COPIED_RESET_MS = 1600
let resetTimer: ReturnType<typeof setTimeout> | null = null

function clearResetTimer(): void {
  if (resetTimer) {
    clearTimeout(resetTimer)
    resetTimer = null
  }
}

async function handleClick(): Promise<void> {
  const text = props.value ?? props.getValue?.() ?? ''
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    clearResetTimer()
    resetTimer = setTimeout(() => {
      copied.value = false
      resetTimer = null
    }, COPIED_RESET_MS)
  } catch {
    // Stay silent on clipboard failure: the text is still selectable for
    // manual copy, so a toast would be noisier than the failure warrants.
  }
}

onBeforeUnmount(clearResetTimer)

const Icon = computed(() => (copied.value ? Check : Copy))
</script>

<template>
  <button
    type="button"
    class="base-copy-button"
    :class="{ 'is-copied': copied }"
    :aria-label="ariaLabel"
    :title="ariaLabel"
    @click="handleClick"
  >
    <component :is="Icon" :size="size" />
  </button>
</template>

<style scoped>
.base-copy-button {
  appearance: none;
  background: transparent;
  border: 1px solid transparent;
  color: var(--neutral-400);
  padding: 4px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease;
}
.base-copy-button:hover,
.base-copy-button:focus-visible {
  color: var(--neutral-200);
  background: var(--brand-surface-bg, rgba(255, 255, 255, 0.06));
  border-color: var(--brand-surface-border, rgba(255, 255, 255, 0.08));
  outline: none;
}
.base-copy-button.is-copied {
  color: var(--semantic-success, var(--neutral-50));
}
</style>
