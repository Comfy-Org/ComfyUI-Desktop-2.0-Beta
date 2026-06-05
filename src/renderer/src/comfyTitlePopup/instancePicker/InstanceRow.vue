<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { installTypeMetaForInstall } from '../../lib/installTypeIcon'
import { TID } from '../../../../shared/testIds'
import type { CloudCapacityStatus, Installation } from '../../types/ipc'

// Compact list-row for the picker's left pane. Body click emits `select`
// (updates the right detail pane only; doesn't launch).

interface Props {
  installation: Installation
  active?: boolean
  running?: boolean
  /** Install whose host window opened the picker; drives the "Current" pill. */
  isCurrent?: boolean
  /** Drives the orange dot, which takes precedence over the green running dot. */
  updateAvailable?: boolean
  /** Background op in flight; spinner dot takes precedence over the other dots. */
  operating?: boolean
  lastLaunchedShortLabel: string
  /** Cloud-only capacity status: `disabled` no-ops the launch (footer also
   *  gates), `degraded` swaps the recency label for a "Heavy usage" chip. */
  capacityStatus?: CloudCapacityStatus
}

const props = withDefaults(defineProps<Props>(), {
  active: false,
  running: false,
  isCurrent: false,
  updateAvailable: false,
  operating: false,
  capacityStatus: 'normal',
})

const isCloud = computed(() => props.installation.sourceCategory === 'cloud')
const isCloudDisabled = computed(() => isCloud.value && props.capacityStatus === 'disabled')
const isCloudDegraded = computed(() => isCloud.value && props.capacityStatus === 'degraded')

const { t } = useI18n()

const emit = defineEmits<{
  select: [installation: Installation]
}>()

const typeMeta = computed(() => installTypeMetaForInstall(props.installation))

function handleClick(): void {
  // Always selects, even for a disabled cloud install, so the user can
  // navigate to the cloud tab; the launch gate lives on the footer action.
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
        <span
          v-if="operating"
          class="picker-row-op-dot"
          aria-hidden="true"
        ></span>
        <span
          v-else-if="updateAvailable"
          class="picker-row-update-dot"
          aria-hidden="true"
        ></span>
        <span
          v-else-if="running"
          class="picker-row-running-dot"
          aria-hidden="true"
        ></span>
      </div>
      <div class="picker-row-body">
        <span class="picker-row-name">{{ installation.name }}</span>
        <span
          v-if="isCloudDisabled"
          class="picker-row-capacity-pill picker-row-capacity-pill--disabled"
          :title="$t('cloud.capacityDisabledHint')"
        >
          {{ $t('cloud.capacityDisabled') }}
        </span>
        <span
          v-else-if="isCloudDegraded"
          class="picker-row-capacity-pill"
          :title="$t('cloud.capacityDegradedHint')"
        >
          {{ $t('cloud.capacityDegraded') }}
        </span>
        <span v-else-if="isCurrent" class="picker-row-current-pill">
          {{ t('snapshots.current') }}
        </span>
        <span v-else-if="lastLaunchedShortLabel" class="picker-row-recency">
          {{ lastLaunchedShortLabel }}
        </span>
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
  grid-template-columns: 24px minmax(0, 1fr);
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
.picker-row.is-active .picker-row-icon {
  color: var(--text);
}
.picker-row-body {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
}
.picker-row-name {
  flex: 1 1 auto;
  min-width: 0;
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
.picker-row-recency {
  flex: 0 0 auto;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
  white-space: nowrap;
}
.picker-row-running-dot {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #38c149;
  border: 2px solid #38303d;
  box-sizing: content-box;
}
.picker-row-update-dot {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-update, #f59e0b);
  border: 2px solid #38303d;
  box-sizing: content-box;
}
/* Spinner dot for in-flight background ops, drawn with a conic-gradient. */
.picker-row-op-dot {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: conic-gradient(var(--brand-accent, #f5c518) 270deg, transparent 270deg);
  border: 2px solid #38303d;
  box-sizing: content-box;
  animation: op-dot-spin 0.8s linear infinite;
}
@keyframes op-dot-spin {
  to { transform: rotate(360deg); }
}

.picker-row-current-pill {
  flex: 0 0 auto;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 10%, transparent);
  border-radius: 999px;
  white-space: nowrap;
}
.picker-row.is-active .picker-row-current-pill {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 14%, transparent);
}

.picker-row-capacity-pill {
  flex: 0 0 auto;
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--accent-warn, #d97706);
  background: var(--accent-warn-soft, rgba(255, 193, 7, 0.15));
  border: 1px solid var(--accent-warn, #d97706);
  border-radius: 999px;
  white-space: nowrap;
}
.picker-row-capacity-pill--disabled {
  color: var(--accent-danger, #d92d20);
  background: var(--accent-danger-soft, rgba(217, 45, 32, 0.12));
  border-color: var(--accent-danger, #d92d20);
}
</style>
