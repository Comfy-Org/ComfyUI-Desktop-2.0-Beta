<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Tag, Boxes } from 'lucide-vue-next'
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
  /** Resulting ComfyUI version of the PREVIOUS snapshot. When this snapshot
   *  changed the ComfyUI version, the title pill shows the transition
   *  (`prev → this`) instead of just the resulting version. */
  previousComfyuiVersion?: string
  /** Optional `data-testid` for the header toggle — lets the parent
   *  scope tests to a specific snapshot by filename. */
  toggleTestId?: string
}

const props = withDefaults(defineProps<Props>(), {
  isLatest: false,
  previousComfyuiVersion: undefined,
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

/** Node-change deltas vs the previous snapshot — drives the collapsed-header
 *  pills so a snapshot's at-a-glance summary is visible without expanding.
 *  The version pill (resulting ComfyUI version) shows always; node deltas
 *  only when something changed. */
const nodeDelta = computed(() => {
  const d = props.snapshot.diffVsPrevious
  return {
    added: d?.nodesAdded ?? 0,
    removed: d?.nodesRemoved ?? 0,
    changed: d?.nodesChanged ?? 0,
  }
})
const hasNodeChanges = computed(
  () => nodeDelta.value.added + nodeDelta.value.removed + nodeDelta.value.changed > 0
)

/**
 * The pill shown next to the trigger title. One pill, content by context:
 *  - manual snapshots with a label → the label (e.g. "Manual (before-fix)")
 *  - a ComfyUI version change      → the transition "prev → this"
 *  - everything else               → the resulting ComfyUI version
 * Reuses the version-pill chrome in all cases.
 */
const isManualWithLabel = computed(
  () => props.snapshot.trigger === 'manual' && !!props.snapshot.label
)
const comfyuiChanged = computed(
  () => !!props.snapshot.diffVsPrevious?.comfyuiChanged && !!props.previousComfyuiVersion
)
const titlePillText = computed(() => {
  if (isManualWithLabel.value) return props.snapshot.label as string
  if (comfyuiChanged.value) return `${props.previousComfyuiVersion} → ${props.snapshot.comfyuiVersion}`
  return props.snapshot.comfyuiVersion
})
const hasTitlePill = computed(() => !!titlePillText.value)
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
      <div class="snapshot-row-head-top">
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
      </div>
      <!-- Second row — at-a-glance pills:
           • version / name pill: ComfyUI version transition
             ("v0.21.0 → v0.22.3") when it changed, the snapshot's name for
             manual snapshots, else the resulting version.
           • node deltas vs the previous snapshot (when any changed). -->
      <div v-if="hasTitlePill || hasNodeChanges" class="snapshot-row-pills">
        <span
          v-if="hasTitlePill"
          class="snap-pill snap-pill--version"
          :class="{ 'is-change': comfyuiChanged }"
          :title="titlePillText"
        >
          <Tag :size="11" aria-hidden="true" />
          <span>{{ titlePillText }}</span>
        </span>
        <span v-if="hasNodeChanges" class="snap-pill snap-pill--nodes">
          <Boxes :size="11" aria-hidden="true" />
          <span v-if="nodeDelta.added" class="snap-delta is-add">+{{ nodeDelta.added }}</span>
          <span v-if="nodeDelta.removed" class="snap-delta is-remove">−{{ nodeDelta.removed }}</span>
          <span v-if="nodeDelta.changed" class="snap-delta is-change">~{{ nodeDelta.changed }}</span>
          <span class="snap-pill-label">{{ t('snapshots.nodesLabel', 'nodes') }}</span>
        </span>
      </div>
    </button>

    <!-- Body card animates open/closed via BaseAccordion. -->
    <BaseAccordion :open="expanded">
      <div class="snapshot-row-card">
        <!-- Composition totals. Version is intentionally omitted — it's
             already shown in the collapsed-header version pill, so repeating
             it here read as redundant. -->
        <div class="snapshot-row-meta">
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
  flex-direction: column;
  gap: 6px;
  padding: 0;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
  width: 100%;
}

.snapshot-row-head-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
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

/* Collapsed-state summary pills (version + node deltas). */
.snapshot-row-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.snap-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 16px;
  background: var(--color-bg);
  color: var(--text-muted);
  white-space: nowrap;
}
.snap-pill > svg {
  flex-shrink: 0;
  opacity: 0.7;
}
.snap-pill--version {
  color: var(--neutral-100);
  background: var(--brand-surface-bg);
  border: 1px solid var(--chooser-surface-border);
  font-variant-numeric: tabular-nums;
  /* On the wrapping pills row a wide transition ("v0.21.0 → v0.22.3") or a
     long manual name wraps to its own line; cap at the row width and ellipsis
     only in the extreme so it never overflows the popover. */
  min-width: 0;
  max-width: 100%;
}
.snap-pill--version > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
/* Version change → subtle brand-tinted border to flag it's a transition. */
.snap-pill--version.is-change {
  border-color: color-mix(in srgb, var(--comfy-yellow, #f0ff41) 45%, var(--chooser-surface-border));
}
.snap-delta {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.snap-delta.is-add {
  color: #22c55e;
}
.snap-delta.is-remove {
  color: var(--danger);
}
.snap-delta.is-change {
  color: var(--warning);
}
.snap-pill-label {
  opacity: 0.7;
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
