<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Download, RotateCcw, Trash2 } from 'lucide-vue-next'
import type { SnapshotSummary } from '../../types/ipc'
import { triggerLabel as _triggerLabel, formatRelative as _formatRelative, formatDate } from '../../lib/snapshots'

/**
 * Single snapshot row for the brand-redesigned Snapshots view. The
 * row reports its summary state (timestamp, trigger label, package /
 * node counts) and exposes three inline actions (Restore / Export /
 * Delete). Expanding the row toggles the parent's inline detail
 * panel; the row itself is presentational.
 */

interface Props {
  snapshot: SnapshotSummary
  expanded: boolean
}

const props = defineProps<Props>()

const emit = defineEmits<{
  toggle: []
  restore: []
  export: []
  delete: []
}>()

const { t } = useI18n()

const triggerCopy = computed(() => _triggerLabel(props.snapshot.trigger, t))
const relativeCopy = computed(() => _formatRelative(props.snapshot.createdAt, t))
const absoluteCopy = computed(() => formatDate(props.snapshot.createdAt))
</script>

<template>
  <div class="snapshot-row" :class="{ 'is-expanded': expanded }">
    <button
      type="button"
      class="snapshot-row-summary"
      :aria-expanded="expanded"
      @click="emit('toggle')"
    >
      <div class="snapshot-row-headline">
        <span class="snapshot-row-time" :title="absoluteCopy">{{ relativeCopy }}</span>
        <span class="snapshot-row-trigger">{{ triggerCopy }}</span>
      </div>
      <div class="snapshot-row-counts">
        <span>{{ t('snapshots.packagesShort', { n: snapshot.pipPackageCount }) }}</span>
        <span class="snapshot-row-dot">·</span>
        <span>{{ t('snapshots.nodesShort', { n: snapshot.nodeCount }) }}</span>
        <span v-if="snapshot.comfyuiVersion" class="snapshot-row-dot">·</span>
        <span v-if="snapshot.comfyuiVersion">{{ snapshot.comfyuiVersion }}</span>
      </div>
      <ChevronDown :size="14" class="snapshot-row-chevron" />
    </button>

    <div class="snapshot-row-actions">
      <button
        type="button"
        class="snapshot-row-action"
        :aria-label="t('snapshots.restore', 'Restore')"
        :title="t('snapshots.restore', 'Restore')"
        @click="emit('restore')"
      >
        <RotateCcw :size="13" />
      </button>
      <button
        type="button"
        class="snapshot-row-action"
        :aria-label="t('snapshots.export', 'Export')"
        :title="t('snapshots.export', 'Export')"
        @click="emit('export')"
      >
        <Download :size="13" />
      </button>
      <button
        type="button"
        class="snapshot-row-action snapshot-row-action-danger"
        :aria-label="t('snapshots.delete', 'Delete')"
        :title="t('snapshots.delete', 'Delete')"
        @click="emit('delete')"
      >
        <Trash2 :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.snapshot-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  transition: border-color 120ms ease, background-color 120ms ease;
}

.snapshot-row.is-expanded {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
}

.snapshot-row-summary {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 4px 8px;
  background: transparent;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.snapshot-row-summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.snapshot-row-headline {
  grid-column: 1 / 2;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.snapshot-row-time {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.snapshot-row-trigger {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 2px 6px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 999px;
}

.snapshot-row-counts {
  grid-column: 1 / 2;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.snapshot-row-dot {
  opacity: 0.5;
}

.snapshot-row-chevron {
  grid-column: 2 / 3;
  grid-row: 1 / 3;
  color: var(--text-muted);
  transition: transform 120ms ease;
  align-self: center;
}

.snapshot-row.is-expanded .snapshot-row-chevron {
  transform: rotate(180deg);
}

.snapshot-row-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.snapshot-row-action {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease;
}

.snapshot-row-action:hover {
  color: var(--text);
  border-color: var(--border-hover);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.snapshot-row-action:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.snapshot-row-action-danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}
</style>
