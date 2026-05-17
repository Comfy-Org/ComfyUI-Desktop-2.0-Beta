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
  /** First (newest) snapshot in the timeline carries a "Current" badge. */
  isCurrent?: boolean
}

const props = withDefaults(defineProps<Props>(), { isCurrent: false })

const emit = defineEmits<{
  toggle: []
}>()

const { t } = useI18n()

const triggerCopy = computed(() => _triggerLabel(props.snapshot.trigger, t))
const relativeCopy = computed(() => _formatRelative(props.snapshot.createdAt, t))
const absoluteCopy = computed(() => formatDate(props.snapshot.createdAt))

/** Some snapshot payloads carry `comfyuiVersion` already prefixed with
 *  "v" (e.g. "v0.21.1"), others don't ("0.21.1"). Normalise so we never
 *  render "vv0.21.1" while still leading with "v" for clarity. */
const versionLabel = computed(() => {
  const raw = props.snapshot.comfyuiVersion ?? ''
  if (!raw) return ''
  return raw.startsWith('v') || raw.startsWith('V') ? raw : `v${raw}`
})

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

/** Diff chips derived from `diffVsPrevious`. We surface up to three
 *  high-signal facts: ComfyUI version change, package change count,
 *  node change count. The full summary list still renders in the
 *  expanded detail; these are the at-a-glance summary. */
interface Chip {
  key: string
  label: string
  tone: 'state' | 'neutral'
}

const chips = computed<Chip[]>(() => {
  const diff = props.snapshot.diffVsPrevious
  if (!diff) return []
  const out: Chip[] = []
  if (diff.comfyuiChanged) {
    out.push({
      key: 'comfy',
      label: t('snapshots.comfyuiUpdated', 'ComfyUI updated'),
      tone: 'state'
    })
  }
  const pipDelta = diff.pipsAdded + diff.pipsRemoved + diff.pipsChanged
  if (pipDelta > 0) {
    out.push({
      key: 'pip',
      label: t('snapshots.pipChanges', { count: pipDelta }),
      tone: 'neutral'
    })
  }
  const nodeDelta = diff.nodesAdded + diff.nodesRemoved + diff.nodesChanged
  if (nodeDelta > 0) {
    out.push({
      key: 'nodes',
      label: t('snapshots.nodeChanges', { count: nodeDelta }),
      tone: 'neutral'
    })
  }
  return out
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
      @click="emit('toggle')"
    >
      <div class="snapshot-row-head-left">
        <span class="snapshot-row-trigger" :data-tone="triggerTone">{{ triggerCopy }}</span>
        <span v-if="isCurrent" class="snapshot-row-current">
          {{ t('snapshots.current', 'Current') }}
        </span>
      </div>
      <div class="snapshot-row-head-right">
        <span class="snapshot-row-time" :title="absoluteCopy">{{ relativeCopy }}</span>
        <ChevronDown :size="14" class="snapshot-row-chevron" />
      </div>
    </button>

    <!-- Bordered card holds the body content only. Sits below the
         header so the dot on the rail aligns with the header text, not
         with this card's edge. When expanded, the parent's <expanded>
         slot renders inside the card so the change summary + actions
         look visually fused with the row body. -->
    <div class="snapshot-row-card">
      <div v-if="chips.length > 0" class="snapshot-row-chips">
        <span
          v-for="chip in chips"
          :key="chip.key"
          class="snapshot-row-chip"
          :data-tone="chip.tone"
          >{{ chip.label }}</span
        >
      </div>

      <div class="snapshot-row-meta">
        <span v-if="snapshot.comfyuiVersion">{{ versionLabel }}</span>
        <span v-if="snapshot.comfyuiVersion" class="snapshot-row-meta-dot">·</span>
        <span>{{ t('snapshots.nodesCount', { count: snapshot.nodeCount }) }}</span>
        <span class="snapshot-row-meta-dot">·</span>
        <span>{{ t('snapshots.packagesCount', { count: snapshot.pipPackageCount }) }}</span>
      </div>

      <!-- Smooth height-animated accordion. Keeps the slot mounted so
           layout is measured for the open transition; the wrapping
           BaseAccordion clips and fades during the height change. -->
      <BaseAccordion :open="expanded">
        <div class="snapshot-row-expanded">
          <slot name="expanded" />
        </div>
      </BaseAccordion>
    </div>
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

.snapshot-row-current {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-accent);
  background: rgba(96, 165, 250, 0.15);
  border-radius: 3px;
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
  padding: 8px;
  background: var(--secondary-background);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  transition: border-color 120ms ease;
}

.snapshot-row-card > * + * {
  margin-top: 8px;
}

.snapshot-row-card > [data-state='closed'] {
  margin-top: 0;
}

.snapshot-row.is-expanded .snapshot-row-card {
  border-color: color-mix(in srgb, var(--accent-primary) 60%, var(--border));
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
