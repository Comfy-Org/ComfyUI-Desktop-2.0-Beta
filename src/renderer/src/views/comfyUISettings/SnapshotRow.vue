<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import type { SnapshotSummary } from '../../types/ipc'
import {
  triggerLabel as _triggerLabel,
  formatRelative as _formatRelative,
  formatDate
} from '../../lib/snapshots'
import BaseAccordion from '../../components/ui/BaseAccordion.vue'

/**
 * Snapshot timeline row. Header line carries the trigger label, an
 * optional "Current" badge, the relative timestamp, and an expand
 * chevron. The body below stays always-visible and surfaces a
 * compact change-summary (chips for diff-vs-previous, then a meta
 * line of `v{comfy} · n nodes · n packages`). All destructive /
 * mutating actions live in the parent's expanded detail panel so
 * the row itself stays single-purpose: a tap target that opens the
 * detail.
 */

interface Props {
  snapshot: SnapshotSummary
  expanded: boolean
  /** First (newest) snapshot in the timeline carries a "Latest" badge. */
  isLatest?: boolean
  /** Optional `data-testid` for the header toggle — lets the parent
   *  scope tests to a specific snapshot by filename. */
  toggleTestId?: string
}

const props = withDefaults(defineProps<Props>(), {
  isLatest: false,
  toggleTestId: undefined,
})

const emit = defineEmits<{
  toggle: []
}>()

const { t } = useI18n()

const triggerCopy = computed(() => _triggerLabel(props.snapshot.trigger, t))
const relativeCopy = computed(() => _formatRelative(props.snapshot.createdAt, t))
const absoluteCopy = computed(() => formatDate(props.snapshot.createdAt))

/** Trigger tone — `state` (post-update / post-restore) is highlighted
 *  because it marks an actual state transition; everything else stays
 *  neutral so the eye is drawn to meaningful changes first. */
const triggerTone = computed<'state' | 'neutral'>(() => {
  switch (props.snapshot.trigger) {
    case 'post-update':
    case 'post-restore':
      return 'state'
    default:
      return 'neutral'
  }
})
</script>

<template>
  <div class="snapshot-row" :class="{ 'is-expanded': expanded }">
    <!-- Header sits on the timeline rail (no border), aligned with the
         dot. Trigger label + Current badge on the left, time + chevron
         on the right. The whole header is the expand toggle. -->
    <button
      type="button"
      class="snapshot-row-head"
      :aria-expanded="expanded"
      :data-testid="toggleTestId"
      @click="emit('toggle')"
    >
      <div class="snapshot-row-head-left">
        <span class="snapshot-row-trigger" :data-tone="triggerTone">{{ triggerCopy }}</span>
        <span v-if="isLatest" class="snapshot-row-latest">
          {{ t('snapshots.latestBadge', 'Latest') }}
        </span>
      </div>
      <div class="snapshot-row-head-right">
        <span class="snapshot-row-time" :title="absoluteCopy">{{ relativeCopy }}</span>
        <ChevronDown :size="14" class="snapshot-row-chevron" />
      </div>
    </button>

    <!-- Body card animates open/closed via BaseAccordion. -->
    <BaseAccordion :open="expanded">
      <div class="snapshot-row-card">
        <div class="snapshot-row-meta">
          <span v-if="snapshot.comfyuiVersion">{{ snapshot.comfyuiVersion }}</span>
          <span v-if="snapshot.comfyuiVersion" class="snapshot-row-meta-dot">·</span>
          <span>{{ t('snapshots.nodesCount', { count: snapshot.nodeCount }) }}</span>
          <span class="snapshot-row-meta-dot">·</span>
          <span>{{ t('snapshots.packagesCount', { count: snapshot.pipPackageCount }) }}</span>
        </div>
        <div class="snapshot-row-expanded">
          <slot name="expanded" />
        </div>
      </div>
    </BaseAccordion>
  </div>
</template>

<style scoped>
.snapshot-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* Header sits on the rail with no background, no border — it's at the
 * same visual level as the dot on the timeline. The full strip is a
 * click target that resets global button chrome. */
.snapshot-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  width: 100%;
}

.snapshot-row-head:hover .snapshot-row-trigger {
  text-decoration: none;
}

.snapshot-row-head:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 4px;
  border-radius: 4px;
}

.snapshot-row-head-left,
.snapshot-row-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.snapshot-row-trigger {
  font-size: 12px;
  color: var(--neutral-100);
}

.snapshot-row-trigger[data-tone='state'] {
  color: var(--warning);
}

.snapshot-row-latest {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 999px;
  line-height: 16.5px;
}

.snapshot-row-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
}

.snapshot-row-chevron {
  color: var(--text-muted);
  transition: transform 180ms cubic-bezier(0.4, 0, 0.2, 1);
}

.snapshot-row.is-expanded .snapshot-row-chevron {
  transform: rotate(180deg);
}

.snapshot-row-card {
  display: flex;
  flex-direction: column;
  padding: 10px 12px;
  background: var(--brand-surface-bg);
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
}

.snapshot-row-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.snapshot-row-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--color-bg);
  border-radius: 3px;
  white-space: nowrap;
}

.snapshot-row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
  padding: 1px 6px;
}

.snapshot-row-meta-dot {
  opacity: 0.5;
}

.snapshot-row-expanded {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border-hover);
}
</style>
