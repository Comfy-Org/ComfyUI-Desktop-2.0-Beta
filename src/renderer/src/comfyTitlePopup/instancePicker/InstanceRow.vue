<script setup lang="ts">
import { computed } from 'vue'
import { installTypeMetaFor } from '../../lib/installTypeIcon'
import type { Installation } from '../../types/ipc'

/**
 * Compact row for the instance-picker popover's left pane.
 *
 * Designed as a row variant of the chooser-tile, NOT a re-wrapping of
 * `ChooserInstallTile.vue` — its golden-ratio tile dimensions + CTA
 * cluster don't fit a list, and shoehorning a row-variant prop into a
 * tile component would hurt both surfaces. The glass tokens
 * (`--chooser-surface-bg`, `--chooser-surface-bg-hover`,
 * `--chooser-surface-border`) are the same so the picker reads as a
 * compact chooser.
 *
 * Interactions:
 *   - Body click → `select` (switcher contract: updates the right
 *     detail pane only; the actual launch waits on the Open button).
 *   - Hover / focus → background highlight; active state when the row
 *     is the currently-selected install.
 *
 * Per-install action menu (Manage / Update / Delete / etc.)
 * intentionally NOT exposed here — see `InstancePickerView.vue` for
 * the rationale. The picker is single-purpose; install actions live
 * on the ComfyUI Settings drawer.
 */

interface Props {
  installation: Installation
  /** Row reads as the currently-selected install (drives the active
   *  highlight + the right detail pane). */
  active?: boolean
  /** Install is currently running in some other window — drives the
   *  small running dot on the row. */
  running?: boolean
  /** Pre-formatted "Launched 17m ago" / "Not launched yet" — the
   *  picker view owns the formatter so all rows render the same clock. */
  lastLaunchedLabel: string
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  running: false,
})

const emit = defineEmits<{
  select: [installation: Installation]
}>()

const typeMeta = computed(() => installTypeMetaFor(props.installation.sourceCategory))

function handleClick(): void {
  emit('select', props.installation)
}
</script>

<template>
  <div class="picker-row-wrap">
    <div
      role="button"
      tabindex="0"
      class="picker-row"
      :class="{ 'is-active': active, 'is-running': running }"
      @click="handleClick"
      @keydown.enter="handleClick"
      @keydown.space.prevent="handleClick"
    >
      <div class="picker-row-icon" :title="$t(typeMeta.labelKey)">
        <component :is="typeMeta.icon" :size="20" />
      </div>
      <div class="picker-row-body">
        <div class="picker-row-name">{{ installation.name }}</div>
        <div class="picker-row-sub">{{ lastLaunchedLabel }}</div>
      </div>
      <span v-if="running" class="picker-row-running-dot" aria-hidden="true"></span>
    </div>
  </div>
</template>

<style scoped>
.picker-row-wrap {
  padding: 2px 8px;
  width: 100%;
  box-sizing: border-box;
}
.picker-row {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
  transition: background-color 120ms ease;
}
.picker-row:hover,
.picker-row:focus-visible {
  background: var(--pick-bg);
  outline: none;
}
.picker-row.is-active {
  background: var(--pick-bg-active);
}
.picker-row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--neutral-100);
  flex: 0 0 auto;
}
.picker-row-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.picker-row-name {
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
  color: var(--neutral-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picker-row-sub {
  font-size: 12px;
  line-height: 16px;
  color: var(--neutral-100);
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picker-row-running-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary, #0b8ce9);
  flex: 0 0 auto;
}
</style>
