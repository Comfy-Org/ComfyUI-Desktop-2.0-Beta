<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Camera, RotateCcw, Trash2 } from 'lucide-vue-next'
import SnapshotRow from '../../views/comfyUISettings/SnapshotRow.vue'
import { changeSummary } from '../../lib/snapshots'
import type { SnapshotListData, SnapshotSummary } from '../../types/ipc'

/**
 * Snapshots list rendered inside the instance-picker popover's right-
 * pane accordion. Reuses the same `SnapshotRow` component the unified
 * Settings drawer's `SnapshotsView` uses, so visual chrome — header,
 * trigger label, time pill, expand chevron, change-summary chips,
 * meta line — is byte-identical between the two surfaces without
 * either having to re-declare the row template.
 *
 * Mutating actions (save / restore / delete) are emitted upward; the
 * picker view dispatches them through the popup-process bridge, which
 * routes to the same main-side handler the drawer's `runAction`
 * pipeline uses. The popup process doesn't have access to the
 * renderer-side `useModal` primitive, so destructive flows use
 * `window.confirm` for the "are you sure" gate — coarser than the
 * drawer's modal but visible and predictable in the popup context.
 *
 * Heavier flows (snapshot diff drilldown, export / import) intentionally
 * stay in the full drawer where the surface has room for them; the
 * picker is the at-a-glance affordance for save + restore + delete.
 */

interface Props {
  data: SnapshotListData | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  save: []
  restore: [filename: string]
  delete: [filename: string]
}>()

const { t } = useI18n()

const snapshots = computed<SnapshotSummary[]>(() => props.data?.snapshots ?? [])
const hasSnapshots = computed(() => snapshots.value.length > 0)

const expanded = ref<string | null>(null)
function toggleExpand(filename: string): void {
  expanded.value = expanded.value === filename ? null : filename
}

function summaryFor(snapshot: SnapshotSummary): string[] {
  return changeSummary(snapshot, t)
}

function handleRestore(snapshot: SnapshotSummary): void {
  const ok = window.confirm(
    t(
      'snapshots.restoreConfirm',
      'Are you sure you want to restore this snapshot? Your current install state will be replaced.',
    ),
  )
  if (!ok) return
  emit('restore', snapshot.filename)
}

function handleDelete(snapshot: SnapshotSummary): void {
  const ok = window.confirm(t('snapshots.deleteConfirm', 'Delete this snapshot?'))
  if (!ok) return
  emit('delete', snapshot.filename)
}
</script>

<template>
  <div class="picker-snapshots">
    <button type="button" class="picker-snapshots-save" @click="emit('save')">
      <Camera :size="14" aria-hidden="true" />
      <span>{{ t('snapshots.saveSnapshot', 'Save snapshot') }}</span>
    </button>

    <div v-if="hasSnapshots" class="picker-snapshots-list">
      <SnapshotRow
        v-for="(snap, idx) in snapshots"
        :key="snap.filename"
        :snapshot="snap"
        :expanded="expanded === snap.filename"
        :is-current="idx === 0"
        @toggle="toggleExpand(snap.filename)"
      >
        <template #expanded>
          <div class="picker-snapshot-summary">
            <p
              v-for="(line, i) in summaryFor(snap)"
              :key="`l-${i}`"
              class="picker-snapshot-summary-line"
            >
              {{ line }}
            </p>
            <div class="picker-snapshot-actions">
              <button
                type="button"
                class="picker-snapshot-action is-primary"
                @click="handleRestore(snap)"
              >
                <RotateCcw :size="12" aria-hidden="true" />
                <span>{{ t('snapshots.restore', 'Restore') }}</span>
              </button>
              <button
                type="button"
                class="picker-snapshot-action is-danger"
                @click="handleDelete(snap)"
              >
                <Trash2 :size="12" aria-hidden="true" />
                <span>{{ t('snapshots.delete', 'Delete') }}</span>
              </button>
            </div>
          </div>
        </template>
      </SnapshotRow>
    </div>

    <div v-else class="picker-snapshots-empty">
      {{
        t(
          'snapshots.empty',
          'No snapshots yet. Snapshots are captured automatically when ComfyUI starts.',
        )
      }}
    </div>
  </div>
</template>

<style scoped>
.picker-snapshots {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.picker-snapshots-save {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: var(--neutral-100);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.picker-snapshots-save:hover,
.picker-snapshots-save:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  outline: none;
}
.picker-snapshots-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.picker-snapshots-empty {
  font-size: 12px;
  color: var(--neutral-100);
  opacity: 0.6;
  padding: 4px 0;
  line-height: 16px;
}
.picker-snapshot-summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.picker-snapshot-summary-line {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}
.picker-snapshot-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.picker-snapshot-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: var(--neutral-100);
  font-size: 12px;
  line-height: 16px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.picker-snapshot-action:hover,
.picker-snapshot-action:focus-visible {
  background: rgba(255, 255, 255, 0.1);
  outline: none;
}
.picker-snapshot-action.is-primary {
  color: var(--accent-primary, #60a5fa);
}
.picker-snapshot-action.is-danger:hover,
.picker-snapshot-action.is-danger:focus-visible {
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
}
</style>
