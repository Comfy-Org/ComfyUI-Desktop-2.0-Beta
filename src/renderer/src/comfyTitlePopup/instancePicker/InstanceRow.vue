<script setup lang="ts">
import { computed } from 'vue'
import { installTypeMetaFor } from '../../lib/installTypeIcon'
import { TID } from '../../../../shared/testIds'
import type { Installation } from '../../types/ipc'

/**
 * Compact list-row for the picker's expanded-mode left pane: icon + name +
 * sub-label + running dot. Body click → `select` (switcher contract — updates
 * the right detail pane only, doesn't launch). Reuses chooser glass tokens
 * so the picker reads as a compact chooser; install actions live on the
 * settings drawer, not here.
 */

interface Props {
  installation: Installation
  /** Row reads as the currently-selected install (drives the active
   *  highlight + the right detail pane). */
  active?: boolean
  /** Install is currently running in some other window — drives the
   *  small running dot on the row. */
  running?: boolean
  /** Pre-formatted "Launched 17m ago" — hidden when the install has never
   *  launched; the picker view owns the formatter. */
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
      role="option"
      :aria-selected="active"
      tabindex="0"
      class="picker-row"
      :class="{ 'is-active': active, 'is-running': running }"
      :data-testid="TID.pickerRow(installation.id)"
      @click="handleClick"
      @keydown.enter="handleClick"
      @keydown.space.prevent="handleClick"
    >
      <div class="picker-row-icon" :title="$t(typeMeta.labelKey)">
        <component :is="typeMeta.icon" :size="20" />
        <span v-if="running" class="picker-row-running-dot" aria-hidden="true"></span>
      </div>
      <div class="picker-row-body">
        <div class="picker-row-name">{{ installation.name }}</div>
        <div
          v-if="installation.lastLaunchedAt != null"
          class="picker-row-sub"
        >
          {{ lastLaunchedLabel }}
        </div>
      </div>
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
  background: var(--chooser-surface-border);
  outline: none;
}
.picker-row.is-active {
  background: var(--chooser-surface-border);
}
.picker-row-icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--neutral-100);
  flex: 0 0 auto;
  transition: color 120ms ease;
}
/* Active row → icon goes full white (and gets a green status dot
 * overlaid on top-right when also running). Inactive running rows
 * still get the green dot so the user sees "running in another
 * window" status, but the icon stays its resting neutral colour. */
.picker-row.is-active .picker-row-icon {
  color: var(--text);
}
.picker-row-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.picker-row-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--neutral-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.picker-row.is-active .picker-row-name {
  color: var(--text);
}
.picker-row-sub {
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Green running indicator pinned to the top-right of the icon. Uses
 * the existing `--success` token. */
.picker-row-running-dot {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--success, #00cd72);
}
</style>
