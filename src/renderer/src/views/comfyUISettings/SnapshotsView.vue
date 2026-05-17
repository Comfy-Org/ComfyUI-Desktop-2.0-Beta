<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FilePlus, FolderInput, Save } from 'lucide-vue-next'
import { useModal } from '../../composables/useModal'
import { emitTelemetryAction, toCountBucket } from '../../lib/telemetry'
import {
  changeSummary as _changeSummary,
  diffHasChanges,
  formatDate,
  formatRelative as _formatRelative,
} from '../../lib/snapshots'
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

/** Header "Latest: 8d ago" stat — derives from the newest timeline
 *  item (snapshot OR copy event). null when there's nothing yet. */
const latestRelative = computed<string | null>(() => {
  const first = timeline.value[0]
  if (!first) return null
  const iso = first.kind === 'snapshot' ? first.snapshot.createdAt : first.event.copiedAt
  return _formatRelative(iso, t)
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
    <!-- Header per Figma: "Latest: 8d ago" left + Import / Export All
         right. Save moves out of the toolbar and into the timeline rail
         below as its own dashed-pending node. -->
    <header class="snapshots-view-header">
      <span class="snapshots-view-latest">
        <template v-if="latestRelative">
          {{ t('snapshots.latestLabel', 'Latest:') }}
          <strong>{{ latestRelative }}</strong>
        </template>
        <template v-else>
          {{ t('snapshots.noneYet', 'No snapshots yet') }}
        </template>
      </span>
      <div class="snapshots-view-toolbar">
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

    <!-- Timeline rail. Vertical 2px line on the left, dot markers per
         entry. The first node is always the dashed-pending "Save New
         Snapshot" CTA. Below it: snapshots (yellow dots) and copy
         events (muted dots), newest first. The rail itself is a
         pseudo-element on the <ul> so it spans the full list height
         without per-item border tricks. -->
    <ul class="snapshots-rail" :class="{ 'is-empty': timeline.length === 0 }">
      <li class="snapshots-rail-node is-save">
        <span class="snapshots-rail-dot is-pending" :aria-hidden="true"></span>
        <div class="snapshots-rail-content">
          <span class="snapshots-rail-label">{{ t('snapshots.saveLabel', 'Save Snapshot') }}</span>
          <button
            type="button"
            class="snapshots-rail-cta primary"
            :aria-label="t('snapshots.saveSnapshot', 'Save Snapshot')"
            @click="handleSave"
          >
            <Save :size="13" />
            <span>{{ t('snapshots.saveNew', 'Save New Snapshot') }}</span>
          </button>
        </div>
      </li>

      <li
        v-for="(item, i) in timeline"
        :key="item.kind === 'snapshot' ? `s-${item.snapshot.filename}` : `c-${i}`"
        class="snapshots-rail-node"
        :class="{
          'is-snapshot': item.kind === 'snapshot',
          'is-copy': item.kind === 'copy',
          'is-current': item.kind === 'snapshot' && i === 0,
        }"
      >
        <span
          class="snapshots-rail-dot"
          :class="{
            'is-current': item.kind === 'snapshot' && i === 0,
            'is-muted': item.kind === 'copy',
          }"
          :aria-hidden="true"
        ></span>
        <div class="snapshots-rail-content">
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

/* Header row: "Latest: 8d ago" left, Import / Export All right. */
.snapshots-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.snapshots-view-latest {
  font-size: var(--takeover-fs-body);
  color: var(--text-muted);
}

.snapshots-view-latest strong {
  color: var(--text);
  font-weight: 500;
}

.snapshots-view-toolbar {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Toolbar buttons consume global `button` chrome. Only need the type
 * token + inline icon layout. */
.snapshots-view-toolbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--takeover-fs-caption);
}

.snapshots-view-status {
  margin: 0;
  font-size: var(--takeover-fs-body);
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

/* --- Timeline rail --------------------------------------------------
 * Vertical 2px rail anchored on the left, with circular dot markers
 * per node. The rail is a single `::before` pseudo on the <ul>, which
 * means the line spans the full list height automatically (no per-item
 * border tricks). Dots are absolutely positioned inside each node so
 * they overlap the rail; content shifts right via padding-left to
 * leave room for the rail. */
.snapshots-rail {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Vertical line. Sits behind the dots (z-index 0). The 6px inset top
 * and bottom keeps the line from poking past the first/last dot. */
.snapshots-rail::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--border);
  border-radius: 1px;
  z-index: 0;
}

.snapshots-rail.is-empty::before {
  bottom: auto;
  height: 24px;
}

.snapshots-rail-node {
  position: relative;
  padding-left: 24px;
  min-height: 12px;
}

/* Dot marker. 12px circle centered on the rail's 2px line. Variants:
 *   default snapshot          → border-only, surface fill
 *   .is-current               → solid yellow (highlights the active
 *                                snapshot per Figma)
 *   .is-muted (copy events)   → muted border, surface fill
 *   .is-pending (Save CTA)    → dashed, no fill — pending action */
.snapshots-rail-dot {
  position: absolute;
  left: 0;
  top: 6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--titlebar-bg);
  border: 2px solid var(--border);
  z-index: 1;
}

.snapshots-rail-dot.is-current {
  background: var(--comfy-yellow);
  border-color: var(--comfy-yellow);
}

.snapshots-rail-dot.is-muted {
  border-color: var(--border-hover);
}

.snapshots-rail-dot.is-pending {
  background: transparent;
  border-style: dashed;
  border-color: var(--text-muted);
}

.snapshots-rail-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Save-new-snapshot CTA — dashed-border full-width primary button.
 * Override global `button` padding so it reads as a tall pending
 * affordance, distinct from the snapshot row chrome below it. */
.snapshots-rail-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  font-size: var(--takeover-fs-body);
}

.snapshots-rail-node.is-save .snapshots-rail-label {
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

.snapshots-view-detail {
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.snapshots-view-label {
  margin: 0 0 6px;
  font-size: var(--takeover-fs-caption);
  font-weight: 500;
  color: var(--text);
}

.snapshots-view-changes {
  list-style: disc;
  margin: 0;
  padding-left: 18px;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.snapshots-view-no-changes {
  margin: 0;
  font-size: var(--takeover-fs-caption);
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
  border-radius: 8px;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

.snapshots-view-copy-icon {
  color: var(--accent-primary);
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
