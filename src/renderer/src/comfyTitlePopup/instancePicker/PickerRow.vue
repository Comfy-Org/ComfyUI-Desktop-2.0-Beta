<script setup lang="ts">
import { computed } from 'vue'
import { installTypeMetaFor } from '../../lib/installTypeIcon'
import type { Installation } from '../../types/ipc'

/**
 * Compact-mode list row: icon + name + meta pills, with Manage + Open
 * actions always visible on the right.
 */

interface Props {
  installation: Installation
  active?: boolean
  running?: boolean
  lastLaunchedLabel: string
  openLabel: string
  manageLabel: string
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  running: false
})

const emit = defineEmits<{
  select: [installation: Installation]
  open: [installation: Installation]
  manage: [installation: Installation]
}>()

const typeMeta = computed(() => installTypeMetaFor(props.installation.sourceCategory))

const versionLabel = computed(() => {
  const raw = props.installation.version
  if (!raw) return ''
  return raw.startsWith('v') || raw.startsWith('V') ? raw : `v${raw}`
})

function handleSelect(): void {
  emit('select', props.installation)
}
function handleOpen(): void {
  emit('open', props.installation)
}
function handleManage(): void {
  emit('manage', props.installation)
}
</script>

<template>
  <div class="picker-compact-row-wrap">
    <div
      role="option"
      :aria-selected="active"
      tabindex="0"
      class="picker-compact-row"
      :class="{ 'is-active': active, 'is-running': running }"
      @click="handleSelect"
      @keydown.enter="handleSelect"
      @keydown.space.prevent="handleSelect"
    >
      <div class="picker-compact-row-icon" :title="$t(typeMeta.labelKey)">
        <component :is="typeMeta.icon" :size="20" aria-hidden="true" />
        <span v-if="running" class="picker-compact-row-running-dot" aria-hidden="true" />
      </div>

      <div class="picker-compact-row-main">
        <span class="picker-compact-row-name">{{ installation.name }}</span>
        <span v-if="versionLabel" class="picker-compact-row-pill picker-compact-row-pill-version">
          {{ versionLabel }}
        </span>
        <span
          v-if="lastLaunchedLabel"
          class="picker-compact-row-pill picker-compact-row-pill-launched"
        >
          {{ lastLaunchedLabel }}
        </span>
      </div>

      <div class="picker-compact-row-actions">
        <button type="button" class="picker-compact-row-manage" @click.stop="handleManage">
          {{ manageLabel }}
        </button>
        <button type="button" class="picker-compact-row-open" @click.stop="handleOpen">
          {{ openLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker-compact-row-wrap {
  width: 100%;
  box-sizing: border-box;
}

.picker-compact-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
  transition: background-color 120ms ease;
}

.picker-compact-row:hover,
.picker-compact-row:focus-visible,
.picker-compact-row.is-active {
  background: rgba(255, 255, 255, 0.04);
  outline: none;
}

.picker-compact-row-icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  color: var(--neutral-100);
  transition: color 120ms ease;
}

.picker-compact-row.is-active .picker-compact-row-icon,
.picker-compact-row:hover .picker-compact-row-icon {
  color: var(--text);
}

.picker-compact-row-running-dot {
  position: absolute;
  bottom: -1px;
  right: -5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #38c149;
  border: 2px solid #38303d;
  box-sizing: content-box;
}

.picker-compact-row-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}

.picker-compact-row-name {
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--neutral-100);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-compact-row.is-active .picker-compact-row-name,
.picker-compact-row:hover .picker-compact-row-name {
  color: var(--text);
}

.picker-compact-row-pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 9999px;
  background: var(--chooser-surface-border);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--neutral-100);
  white-space: nowrap;
  flex: 0 0 auto;
}

.picker-compact-row-pill-version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.picker-compact-row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.picker-compact-row-manage,
.picker-compact-row-open {
  min-height: 28px;
  padding: 4px 12px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
  transition:
    filter 100ms ease,
    background-color 120ms ease,
    border-color 120ms ease;
}

.picker-compact-row-open {
  min-width: 76px;
  text-align: center;
  border: 1px solid var(--accent-primary);
  background: var(--accent-primary);
  color: var(--text);
}

.picker-compact-row-open:hover,
.picker-compact-row-open:focus-visible {
  filter: brightness(1.08);
  outline: none;
}

.picker-compact-row-manage {
  min-width: 76px;
  text-align: center;
  border: 1px solid var(--chooser-surface-border);
  background: transparent;
  color: var(--neutral-100);
}

.picker-compact-row-manage:hover,
.picker-compact-row-manage:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--text);
  outline: none;
}
</style>
