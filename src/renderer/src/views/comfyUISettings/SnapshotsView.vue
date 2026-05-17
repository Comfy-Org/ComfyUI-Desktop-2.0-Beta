<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FilePlus, FolderInput, Save } from 'lucide-vue-next'
import { useModal } from '../../composables/useModal'
import { emitTelemetryAction, toCountBucket } from '../../lib/telemetry'
import { changeSummary as _changeSummary, diffHasChanges, formatDate } from '../../lib/snapshots'
import type {
  ActionDef,
  CopyEvent,
  SnapshotDiffData,
  SnapshotListData,
  SnapshotSummary,
} from '../../types/ipc'
import SnapshotRow from './SnapshotRow.vue'

/**
 * Snapshots tab body for the brand-redesigned Settings drawer (v2).
 * Functional parity with the legacy `SnapshotTab.vue`:
 *
 *   - Save snapshot   (`runAction('snapshot-save', { label })`)
 *   - Restore snapshot (with diff preview confirm step)
 *   - Delete snapshot (`runAction('snapshot-delete', { file })`)
 *   - Export single  (`window.api.exportSnapshot`)
 *   - Export all     (`window.api.exportAllSnapshots`)
 *   - Import flow     (preview → diff → restore)
 *
 * UX is improvised on the Figma — narrow drawer doesn't fit the
 * legacy's side-by-side inspector, so each row expands inline to
 * reveal a change summary, and confirm steps surface via the shared
 * `useModal.confirm` primitive instead of a sub-modal.
 *
 * The component is presentational + IPC-glue only — restore runs
 * through `show-progress` so PanelApp's ProgressModal owns the
 * long-running op (same path the legacy uses).
 */

interface Props {
  installationId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  /** Fires when restore commits — parent (drawer) routes through
   *  `useComfyUISettings.runAction` so the standard show-progress
   *  flow (ProgressModal in PanelApp) handles the long-running op. */
  'run-action': [action: ActionDef]
  /** Lets the drawer host re-load sections after a snapshot op (e.g.
   *  restore navigates back to install detail with refreshed state). */
  'refresh-all': []
}>()

const { t } = useI18n()
const modal = useModal()

const listData = ref<SnapshotListData | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const snapshots = computed<SnapshotSummary[]>(() => listData.value?.snapshots ?? [])
const copyEvents = computed<CopyEvent[]>(() => listData.value?.copyEvents ?? [])

// Merged timeline (snapshots + copy events), newest first.
type TimelineItem =
  | { kind: 'snapshot'; snapshot: SnapshotSummary; snapshotIndex: number }
  | { kind: 'copy'; event: CopyEvent }

const timeline = computed<TimelineItem[]>(() => {
  const out: TimelineItem[] = []
  let si = 0
  let ci = 0
  const snaps = snapshots.value
  const copies = [...copyEvents.value].sort(
    (a, b) => new Date(b.copiedAt).getTime() - new Date(a.copiedAt).getTime(),
  )
  while (si < snaps.length || ci < copies.length) {
    const snapTime = si < snaps.length ? new Date(snaps[si]!.createdAt).getTime() : -Infinity
    const copyTime = ci < copies.length ? new Date(copies[ci]!.copiedAt).getTime() : -Infinity
    if (snapTime >= copyTime) {
      out.push({ kind: 'snapshot', snapshot: snaps[si]!, snapshotIndex: si })
      si++
    } else {
      out.push({ kind: 'copy', event: copies[ci]! })
      ci++
    }
  }
  return out
})

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    listData.value = await window.api.getSnapshots(props.installationId)
  } catch (err: unknown) {
    // Surface IPC rejections — the legacy SnapshotTab swallows these
    // silently and we can't tell "no snapshots" from "load failed".
    loadError.value = (err as Error)?.message ?? String(err)
    listData.value = null
    console.error('SnapshotsView.load failed', err)
  } finally {
    loading.value = false
  }
}

// --- Per-row expansion (change summary) ---

const expanded = ref<string | null>(null)

function toggleExpand(filename: string): void {
  expanded.value = expanded.value === filename ? null : filename
}

watch(
  () => props.installationId,
  () => {
    expanded.value = null
    void load()
  },
  { immediate: true },
)

function changeSummaryFor(s: SnapshotSummary): string[] {
  return _changeSummary(s, t)
}

// --- Save ---

async function handleSave(): Promise<void> {
  const label = await modal.prompt({
    title: t('standalone.snapshotSaveTitle'),
    message: t('standalone.snapshotSaveMessage'),
    placeholder: t('standalone.snapshotLabelPlaceholder'),
    confirmLabel: t('snapshots.saveSnapshot'),
    required: false,
  })
  if (label === null) return
  try {
    await window.api.runAction(props.installationId, 'snapshot-save', {
      label: label || undefined,
    })
  } catch (err: unknown) {
    await modal.alert({
      title: t('snapshots.saveSnapshot'),
      message: (err as Error).message || String(err),
    })
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'save',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
  })
  expanded.value = null
  await load()
  emit('refresh-all')
}

// --- Restore (with diff preview confirm) ---

async function handleRestore(filename: string): Promise<void> {
  let diff: SnapshotDiffData | null
  try {
    diff = await window.api.getSnapshotDiff(props.installationId, filename, 'current')
  } catch {
    diff = null
  }
  const target = snapshots.value.find((s) => s.filename === filename)
  const summaryLines = target ? _changeSummary(target, t) : []
  const hasChanges = diff ? diffHasChanges(diff.diff) : undefined
  const messageDetails = summaryLines.length > 0
    ? [{ label: t('snapshots.willChange', 'Changes when restoring'), items: summaryLines }]
    : undefined

  const ok = await modal.confirm({
    title: t('standalone.snapshotRestore', 'Restore Snapshot'),
    message: t('snapshots.restoreConfirm', 'Are you sure you want to restore this snapshot? Your current install state will be replaced.'),
    messageDetails,
    confirmLabel: t('standalone.snapshotRestore', 'Restore'),
    confirmStyle: 'primary',
  })
  if (!ok) return

  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'restore_complete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    has_diff: hasChanges,
  })

  emit('run-action', {
    id: 'snapshot-restore',
    label: t('standalone.snapshotRestore', 'Restore'),
    data: { file: filename },
    showProgress: true,
    progressTitle: t('standalone.snapshotRestoringTitle', 'Restoring snapshot'),
    cancellable: true,
  })
}

// --- Delete ---

async function handleDelete(filename: string): Promise<void> {
  const ok = await modal.confirm({
    title: t('standalone.snapshotDelete'),
    message: t('snapshots.deleteConfirm'),
    confirmStyle: 'danger',
  })
  if (!ok) return
  try {
    await window.api.runAction(props.installationId, 'snapshot-delete', { file: filename })
  } catch (err: unknown) {
    await modal.alert({
      title: t('snapshots.delete', 'Delete Snapshot'),
      message: (err as Error).message || String(err),
    })
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'delete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
  })
  if (expanded.value === filename) expanded.value = null
  await load()
  emit('refresh-all')
}

// --- Export ---

async function handleExport(filename: string): Promise<void> {
  await window.api.exportSnapshot(props.installationId, filename)
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'export_one',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
  })
}

async function handleExportAll(): Promise<void> {
  await window.api.exportAllSnapshots(props.installationId)
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'export_all',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
  })
}

// --- Import ---

async function handleImport(): Promise<void> {
  // Step 1: pick file(s) → preview
  const preview = await window.api.importSnapshotsPreview()
  if (!preview.ok) {
    if (preview.message) {
      await modal.alert({
        title: t('snapshots.importSnapshots', 'Import Snapshots'),
        message: preview.message,
      })
    }
    return
  }
  const previewItems = preview.preview?.snapshots ?? []
  const previewLines = previewItems.map((p) => `${p.label || p.filename} (${formatDate(p.createdAt)})`)
  const ok = await modal.confirm({
    title: t('snapshots.importSnapshots', 'Import Snapshots'),
    message: t('snapshots.importPreviewMessage', 'Review the snapshots to import.'),
    messageDetails: previewLines.length > 0
      ? [{ label: t('snapshots.importPreviewLabel', 'Snapshots'), items: previewLines }]
      : undefined,
    confirmLabel: t('snapshots.importContinue', 'Continue'),
    confirmStyle: 'primary',
  })
  if (!ok) return

  // Step 2: diff
  const diff = await window.api.importSnapshotsDiff(props.installationId)
  if (!diff.ok) {
    if (diff.message) {
      await modal.alert({
        title: t('snapshots.importSnapshots', 'Import Snapshots'),
        message: diff.message,
      })
    }
    return
  }

  // Step 3: confirm restore on the imported snapshot
  const result = await window.api.importSnapshotsConfirm(props.installationId)
  if (!result.ok) {
    if (result.message) {
      await modal.alert({
        title: t('snapshots.importSnapshots', 'Import Snapshots'),
        message: result.message,
      })
    }
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'import',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    imported_bucket: toCountBucket(result.imported ?? 0),
  })

  await load()
  emit('refresh-all')

  if (result.restoreFile) {
    emit('run-action', {
      id: 'snapshot-restore',
      label: t('standalone.snapshotRestore', 'Restore'),
      data: { file: result.restoreFile },
      showProgress: true,
      progressTitle: t('standalone.snapshotRestoringTitle', 'Restoring snapshot'),
      cancellable: true,
    })
  }
}
</script>

<template>
  <div class="snapshots-view">
    <header class="snapshots-view-header">
      <h2 class="snapshots-view-title">{{ t('snapshots.timeline', 'Snapshots') }}</h2>
      <div class="snapshots-view-toolbar">
        <button
          type="button"
          class="snapshots-view-toolbtn primary"
          :aria-label="t('snapshots.saveSnapshot', 'Save Snapshot')"
          @click="handleSave"
        >
          <Save :size="13" />
          <span>{{ t('snapshots.saveSnapshot', 'Save') }}</span>
        </button>
        <button
          type="button"
          class="snapshots-view-toolbtn"
          :aria-label="t('snapshots.importSnapshots', 'Import')"
          @click="handleImport"
        >
          <FilePlus :size="13" />
          <span>{{ t('snapshots.importSnapshots', 'Import') }}</span>
        </button>
        <button
          type="button"
          class="snapshots-view-toolbtn"
          :disabled="snapshots.length === 0"
          :aria-label="t('snapshots.exportAll', 'Export All')"
          @click="handleExportAll"
        >
          <FolderInput :size="13" />
          <span>{{ t('snapshots.exportAll', 'Export All') }}</span>
        </button>
      </div>
    </header>

    <p v-if="loading" class="snapshots-view-status">{{ t('common.loading', 'Loading…') }}</p>
    <div v-else-if="loadError" class="snapshots-view-status is-error">
      <p>{{ loadError }}</p>
      <button type="button" class="snapshots-view-toolbtn" @click="load">
        {{ t('common.retry', 'Retry') }}
      </button>
    </div>
    <p v-else-if="timeline.length === 0" class="snapshots-view-status">
      {{ t('snapshots.empty', 'No snapshots yet. Save one to record the current install state.') }}
    </p>

    <ul v-else class="snapshots-view-list">
      <li
        v-for="(item, i) in timeline"
        :key="item.kind === 'snapshot' ? `s-${item.snapshot.filename}` : `c-${i}`"
        class="snapshots-view-item"
      >
        <template v-if="item.kind === 'snapshot'">
          <SnapshotRow
            :snapshot="item.snapshot"
            :expanded="expanded === item.snapshot.filename"
            @toggle="toggleExpand(item.snapshot.filename)"
            @restore="handleRestore(item.snapshot.filename)"
            @export="handleExport(item.snapshot.filename)"
            @delete="handleDelete(item.snapshot.filename)"
          />
          <div
            v-if="expanded === item.snapshot.filename"
            class="snapshots-view-detail"
          >
            <p v-if="item.snapshot.label" class="snapshots-view-label">
              {{ item.snapshot.label }}
            </p>
            <ul v-if="changeSummaryFor(item.snapshot).length > 0" class="snapshots-view-changes">
              <li v-for="line in changeSummaryFor(item.snapshot)" :key="line">{{ line }}</li>
            </ul>
            <p v-else class="snapshots-view-no-changes">
              {{ t('snapshots.noChangesSinceLast', 'No changes since the previous snapshot.') }}
            </p>
          </div>
        </template>
        <div v-else class="snapshots-view-copy-event">
          <span class="snapshots-view-copy-icon" :aria-hidden="true">→</span>
          <span class="snapshots-view-copy-label">
            {{ t('snapshots.copyEventLabel', { source: item.event.installationName || item.event.installationId }) }}
          </span>
          <span class="snapshots-view-copy-time">{{ formatDate(item.event.copiedAt) }}</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.snapshots-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.snapshots-view-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.snapshots-view-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.snapshots-view-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.snapshots-view-toolbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.snapshots-view-toolbtn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border-color: var(--border-hover);
}

.snapshots-view-toolbtn.primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 600;
}

.snapshots-view-toolbtn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.snapshots-view-toolbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.snapshots-view-status {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.snapshots-view-status.is-error {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
  color: var(--danger);
}

.snapshots-view-status.is-error p {
  margin: 0;
}

.snapshots-view-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.snapshots-view-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.snapshots-view-detail {
  padding: 10px 12px;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  border: 1px solid var(--border);
  border-radius: 6px;
}

.snapshots-view-label {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}

.snapshots-view-changes {
  list-style: disc;
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.snapshots-view-no-changes {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

.snapshots-view-copy-event {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.snapshots-view-copy-icon {
  color: var(--accent);
}

.snapshots-view-copy-label {
  flex: 1;
  min-width: 0;
}

.snapshots-view-copy-time {
  font-size: 11px;
  opacity: 0.7;
}
</style>
