<script setup lang="ts">
/**
 * Small icon button that copies its `value` (or the result of `getValue()`)
 * to the clipboard via `navigator.clipboard.writeText`. The icon swaps from
 * Copy → Check for ~1.6 s after a successful copy, then resets.
 *
 * Used inline next to selectable text blocks (error messages, terminal
 * tails, captions) so users can grab the text without manual select +
 * keyboard copy — important for the share-this-error-to-Google /
 * paste-into-issue-thread flow.
 *
 * Either pass `value` directly, or pass `getValue` for lazily-resolved
 * strings (e.g. a `computed` whose unwrap shouldn't happen until click).
 */
import { ref, computed, onBeforeUnmount } from 'vue'
import { Copy, Check } from 'lucide-vue-next'

interface Props {
  value?: string
  getValue?: () => string
  /** Icon size in px. Defaults to 14 — matches the adjacent caption /
   *  log-toggle icon weight used elsewhere on the brand loader. */
  size?: number
  /** Optional aria-label override. Defaults to "Copy to clipboard". */
  ariaLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
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
    // Clipboard permissions denied or write failed. Stay silent — the
    // text is still selectable, so the user can fall back to manual
    // keyboard copy. Surfacing an error toast here would be noisier
    // than the failure warrants.
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
