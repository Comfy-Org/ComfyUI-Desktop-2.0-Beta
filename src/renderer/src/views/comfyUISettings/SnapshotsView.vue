<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, GitCompare, RotateCcw, Trash2, Upload } from 'lucide-vue-next'
import { TID } from '../../../../shared/testIds'
import { useDialogs } from '../../composables/useDialogs'
import { useActionGuard } from '../../composables/useActionGuard'
import { emitTelemetryAction, toCountBucket } from '../../lib/telemetry'
import {
  changeSummary as _changeSummary,
  diffHasChanges,
  formatDate,
  formatRelative as _formatRelative
} from '../../lib/snapshots'
import type {
  ActionDef,
  CopyEvent,
  SnapshotDiffData,
  SnapshotListData,
  SnapshotSummary
} from '../../types/ipc'
import SnapshotRow from './SnapshotRow.vue'
import SnapshotDiffView from '../../components/SnapshotDiffView.vue'

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
const dialogs = useDialogs()
const actionGuard = useActionGuard()

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
    (a, b) => new Date(b.copiedAt).getTime() - new Date(a.copiedAt).getTime()
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
    if (expandedFilenames.value.size === 0) {
      const firstSnapshot = timeline.value.find(
        (item): item is Extract<TimelineItem, { kind: 'snapshot' }> => item.kind === 'snapshot'
      )
      if (firstSnapshot) {
        expandedFilenames.value = new Set([firstSnapshot.snapshot.filename])
      }
    }
  }
}

// --- Per-row expansion (change summary) ---

const expandedFilenames = ref<Set<string>>(new Set())
// Loaded "Changes from previous" diffs, keyed by snapshot filename.
// Presence in the map = panel is open; null = loaded with no diff returned.
const diffByFilename = ref<Map<string, SnapshotDiffData | null>>(new Map())
const diffLoadingFilename = ref<string | null>(null)

function isExpanded(filename: string): boolean {
  return expandedFilenames.value.has(filename)
}

function toggleExpand(filename: string): void {
  const next = new Set(expandedFilenames.value)
  if (next.has(filename)) {
    next.delete(filename)
  } else {
    next.add(filename)
  }
  expandedFilenames.value = next
}

function isDiffOpen(filename: string): boolean {
  return diffByFilename.value.has(filename)
}

async function toggleDiff(filename: string): Promise<void> {
  if (diffByFilename.value.has(filename)) {
    const next = new Map(diffByFilename.value)
    next.delete(filename)
    diffByFilename.value = next
    return
  }
  diffLoadingFilename.value = filename
  try {
    const d = await window.api.getSnapshotDiff(props.installationId, filename, 'previous')
    const next = new Map(diffByFilename.value)
    next.set(filename, d)
    diffByFilename.value = next
    emitTelemetryAction('desktop2.snapshot.flow', {
      action: 'view_diff',
      snapshot_count_bucket: toCountBucket(snapshots.value.length),
      has_diff: d ? diffHasChanges(d.diff) : undefined
    })
  } finally {
    diffLoadingFilename.value = null
  }
}

watch(
  () => props.installationId,
  () => {
    expandedFilenames.value = new Set()
    diffByFilename.value = new Map()
    void load()
  },
  { immediate: true }
)

function changeSummaryFor(s: SnapshotSummary): string[] {
  return _changeSummary(s, t)
}

// --- Save ---

async function handleSave(): Promise<void> {
  const label = await dialogs.prompt({
    title: t('standalone.snapshotSaveTitle'),
    message: t('standalone.snapshotSaveMessage'),
    placeholder: t('standalone.snapshotLabelPlaceholder'),
    confirmLabel: t('snapshots.saveSnapshot'),
    required: false
  })
  if (label === null) return
  try {
    await window.api.runAction(props.installationId, 'snapshot-save', {
      label: label || undefined
    })
  } catch (err: unknown) {
    await dialogs.alert({
      title: t('snapshots.saveErrorTitle'),
      message: (err as Error).message || String(err),
      tone: 'danger'
    })
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'save',
    snapshot_count_bucket: toCountBucket(snapshots.value.length)
  })
  expandedFilenames.value = new Set()
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
  const messageDetails =
    summaryLines.length > 0
      ? [{ label: t('snapshots.willChange', 'Changes when restoring'), items: summaryLines }]
      : undefined

  const result = await dialogs.confirm({
    title: t('snapshots.restoreConfirmTitle'),
    message: t('snapshots.restoreConfirmMessage'),
    messageDetails,
    confirmLabel: t('standalone.snapshotRestore', 'Restore'),
    tone: 'primary'
  })
  if (result !== 'primary') return


  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'restore_complete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    has_diff: hasChanges
  })

  // Pass the diff-preview confirm through the emit so
  // `useComfyUISettings.runAction` step 3 augments this existing
  // confirm with the `willStopRunning` warning instead of synthesizing
  // a second one. Single modal whether the install is running or not.
  emit('run-action', {
    id: 'snapshot-restore',
    label: t('standalone.snapshotRestore', 'Restore'),
    data: { file: filename },
    showProgress: true,
    progressTitle: t('standalone.snapshotRestoringTitle', 'Restoring snapshot'),
    cancellable: true,
    style: 'primary',
    confirm: {
      title: t('standalone.snapshotRestore', 'Restore Snapshot'),
      message: t(
        'snapshots.restoreConfirm',
        'Are you sure you want to restore this snapshot? Your current install state will be replaced.'
      ),
      messageDetails,
      confirmLabel: t('standalone.snapshotRestore', 'Restore')
    }
  })
}

// --- Delete ---

async function handleDelete(filename: string): Promise<void> {
  const target = snapshots.value.find((s) => s.filename === filename)
  const displayName = target?.label || target?.filename || ''
  // Title carries the snapshot name (HIG-style: "Delete X?") so the
  // user can scan the destructive scope at a glance. Message
  // explains the consequence in one sentence — no recessed "what
  // happens" block; that was over-engineered for a one-line confirm.
  const result = await dialogs.confirm({
    title: displayName
      ? t('snapshots.deleteConfirmNamed', { name: displayName })
      : t('snapshots.deleteConfirm'),
    message: t('snapshots.deleteConfirmMessage'),
    confirmLabel: t('snapshots.delete'),
    tone: 'danger'
  })
  if (result !== 'primary') return
  try {
    await window.api.runAction(props.installationId, 'snapshot-delete', { file: filename })
  } catch (err: unknown) {
    await dialogs.alert({
      title: t('snapshots.deleteErrorTitle'),
      message: (err as Error).message || String(err),
      tone: 'danger'
    })
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'delete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length)
  })
  if (expandedFilenames.value.has(filename)) {
    const next = new Set(expandedFilenames.value)
    next.delete(filename)
    expandedFilenames.value = next
  }
  await load()
  emit('refresh-all')
}

// --- Export ---

async function handleExport(filename: string): Promise<void> {
  await window.api.exportSnapshot(props.installationId, filename)
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'export_one',
    snapshot_count_bucket: toCountBucket(snapshots.value.length)
  })
}

async function handleExportAll(): Promise<void> {
  await window.api.exportAllSnapshots(props.installationId)
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'export_all',
    snapshot_count_bucket: toCountBucket(snapshots.value.length)
  })
}

// --- Import ---

async function handleImport(): Promise<void> {
  // Step 1: pick file(s) → preview
  const preview = await window.api.importSnapshotsPreview()
  if (!preview.ok) {
    if (preview.message) {
      await dialogs.alert({
        title: t('snapshots.importErrorTitle'),
        message: preview.message,
        tone: 'danger'
      })
    }
    return
  }
  const previewItems = preview.preview?.snapshots ?? []
  const previewLines = previewItems.map(
    (p) => `${p.label || p.filename} (${formatDate(p.createdAt)})`
  )
  const importChoice = await dialogs.confirm({
    title: t('snapshots.importConfirmTitle'),
    message: t('snapshots.importConfirmMessage'),
    messageDetails:
      previewLines.length > 0
        ? [{ label: t('snapshots.importPreviewLabel', 'Snapshots'), items: previewLines }]
        : undefined,
    confirmLabel: t('snapshots.importConfirmLabel'),
    tone: 'primary'
  })
  if (importChoice !== 'primary') return

  // Step 2: diff
  const diff = await window.api.importSnapshotsDiff(props.installationId)
  if (!diff.ok) {
    if (diff.message) {
      await dialogs.alert({
        title: t('snapshots.importErrorTitle'),
        message: diff.message,
        tone: 'danger'
      })
    }
    return
  }

  // Step 3: confirm restore on the imported snapshot. Gate behind the
  // busy guard — confirm writes the staged snapshots into the install
  // and immediately auto-restores from the newest one, so racing an
  // in-flight op (copy / release-update / migrate / running launch)
  // would clobber both surfaces.
  if (!await actionGuard.checkBeforeAction(
    props.installationId,
    t('snapshots.importSnapshots', 'Import Snapshots'),
  )) return
  const importResult = await window.api.importSnapshotsConfirm(props.installationId)
  if (!importResult.ok) {
    if (importResult.message) {
      await dialogs.alert({
        title: t('snapshots.importErrorTitle'),
        message: importResult.message,
        tone: 'danger'
      })
    }
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'import',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    imported_bucket: toCountBucket(importResult.imported ?? 0)
  })

  await load()
  emit('refresh-all')

  if (importResult.restoreFile) {
    emit('run-action', {
      id: 'snapshot-restore',
      label: t('standalone.snapshotRestore', 'Restore'),
      data: { file: importResult.restoreFile },
      showProgress: true,
      progressTitle: t('standalone.snapshotRestoringTitle', 'Restoring snapshot'),
      cancellable: true
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
          {{ latestRelative }}
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
          :data-testid="TID.snapshotsImport"
          @click="handleImport"
        >
          <Upload :size="14" aria-hidden="true" />
          <span>{{ t('snapshots.importSnapshots', 'Import') }}</span>
        </button>
        <button
          type="button"
          class="snapshots-view-toolbtn"
          :disabled="snapshots.length === 0"
          :aria-label="t('snapshots.exportAll', 'Export All')"
          :data-testid="TID.snapshotsExportAll"
          @click="handleExportAll"
        >
          <Download :size="14" aria-hidden="true" />
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
          <!-- "Save Snapshot" label is on the rail (next to the dashed
               dot), matching the trigger label position on snapshot
               rows below. The dashed box wraps only the CTA. -->
          <span class="snapshots-rail-label">
            {{ t('snapshots.saveLabel', 'Save Snapshot') }}
          </span>
          <div class="snapshots-rail-save-box">
            <button
              type="button"
              class="snapshots-rail-cta"
              :aria-label="t('snapshots.saveSnapshot', 'Save Snapshot')"
              @click="handleSave"
            >
              <span>{{ t('snapshots.saveNew', 'Save New Snapshot') }}</span>
            </button>
          </div>
        </div>
      </li>

      <li
        v-for="(item, i) in timeline"
        :key="item.kind === 'snapshot' ? `s-${item.snapshot.filename}` : `c-${i}`"
        class="snapshots-rail-node"
        :class="{
          'is-snapshot': item.kind === 'snapshot',
          'is-copy': item.kind === 'copy',
          'is-current': item.kind === 'snapshot' && i === 0
        }"
      >
        <span
          class="snapshots-rail-dot"
          :class="{
            'is-state':
              item.kind === 'snapshot' &&
              (item.snapshot.trigger === 'post-update' || item.snapshot.trigger === 'post-restore'),
            'is-muted': item.kind === 'copy'
          }"
          :aria-hidden="true"
        ></span>
        <div class="snapshots-rail-content">
          <template v-if="item.kind === 'snapshot'">
            <SnapshotRow
              :snapshot="item.snapshot"
              :expanded="isExpanded(item.snapshot.filename)"
              :is-latest="i === 0"
              :toggle-test-id="TID.snapshotRow(item.snapshot.filename)"
              @toggle="toggleExpand(item.snapshot.filename)"
            >
              <template #expanded>
                <p v-if="item.snapshot.label" class="snapshots-view-label">
                  {{ item.snapshot.label }}
                </p>
                <ul
                  v-if="changeSummaryFor(item.snapshot).length > 0"
                  class="snapshots-view-changes"
                >
                  <li v-for="line in changeSummaryFor(item.snapshot)" :key="line">{{ line }}</li>
                </ul>
                <p v-else class="snapshots-view-no-changes">
                  {{ t('snapshots.noChangesSinceLast', 'No changes since the previous snapshot.') }}
                </p>
                <!-- Inline diff panel (parity with legacy SnapshotInspector
                     "Changes from previous" toggle). Reuses SnapshotDiffView
                     verbatim — no design changes from the per-install legacy. -->
                <div v-if="isDiffOpen(item.snapshot.filename)" class="snapshots-view-diff">
                  <template v-if="diffByFilename.get(item.snapshot.filename)">
                    <div
                      v-if="!diffHasChanges(diffByFilename.get(item.snapshot.filename)!.diff)"
                      class="snapshots-view-diff-empty"
                    >
                      {{ t('snapshots.diffNoChanges', 'No changes') }}
                    </div>
                    <SnapshotDiffView
                      v-else
                      :diff="diffByFilename.get(item.snapshot.filename)!.diff"
                    />
                  </template>
                </div>
                <div
                  v-else-if="diffLoadingFilename === item.snapshot.filename"
                  class="snapshots-view-diff-loading"
                >
                  {{ t('common.loading', 'Loading…') }}
                </div>
                <!-- Actions live in the expanded detail (per Figma): the
                     collapsed row stays a clean tap target, and the
                     destructive / mutating ops only surface once the
                     user has expressed intent by expanding the row. -->
                <div class="snapshots-view-detail-actions">
                  <button
                    type="button"
                    class="snapshots-view-detail-btn"
                    :class="{ 'is-active': isDiffOpen(item.snapshot.filename) }"
                    :disabled="item.snapshotIndex === snapshots.length - 1"
                    :aria-label="t('snapshots.diffPrevious', 'Changes from previous')"
                    :title="
                      item.snapshotIndex === snapshots.length - 1
                        ? t('snapshots.noPrevious', 'First snapshot — no previous to compare')
                        : t('snapshots.diffPrevious', 'Changes from previous')
                    "
                    @click="toggleDiff(item.snapshot.filename)"
                  >
                    <GitCompare :size="13" />
                    <span>{{ t('snapshots.diffPrevious', 'Changes from previous') }}</span>
                  </button>
                  <button
                    type="button"
                    class="snapshots-view-detail-btn"
                    :aria-label="t('snapshots.restore', 'Restore')"
                    :data-testid="TID.snapshotRowRestore(item.snapshot.filename)"
                    @click="handleRestore(item.snapshot.filename)"
                  >
                    <RotateCcw :size="13" />
                    <span>{{ t('snapshots.restore', 'Restore') }}</span>
                  </button>
                  <button
                    type="button"
                    class="snapshots-view-detail-btn"
                    :aria-label="t('snapshots.exportSnapshot', 'Export')"
                    :data-testid="TID.snapshotRowExport(item.snapshot.filename)"
                    @click="handleExport(item.snapshot.filename)"
                  >
                    <Download :size="13" />
                    <span>{{ t('snapshots.exportSnapshot', 'Export') }}</span>
                  </button>
                  <button
                    type="button"
                    class="snapshots-view-detail-btn snapshots-view-detail-btn-danger"
                    :aria-label="t('snapshots.delete', 'Delete')"
                    @click="handleDelete(item.snapshot.filename)"
                  >
                    <Trash2 :size="13" />
                    <span>{{ t('snapshots.delete', 'Delete') }}</span>
                  </button>
                </div>
              </template>
            </SnapshotRow>
          </template>
          <div v-else class="snapshots-view-copy-event">
            <span class="snapshots-view-copy-icon" :aria-hidden="true">→</span>
            <span class="snapshots-view-copy-label">
              {{
                t('snapshots.copyEventLabel', {
                  source: item.event.installationName || item.event.installationId
                })
              }}
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
  gap: 16px;
}

.snapshots-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.snapshots-view-latest {
  font-size: 12px;
  line-height: 16px;
  color: var(--text-muted);
}

.snapshots-view-toolbar {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
}

.snapshots-view-toolbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--neutral-100);
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  cursor: pointer;
  transition: background-color 100ms ease;
}

.snapshots-view-toolbtn:hover:not(:disabled),
.snapshots-view-toolbtn:focus-visible:not(:disabled) {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.snapshots-view-toolbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* Per-node connector line: runs from THIS dot's center down to the
 * NEXT dot's center. Last node has no connector — that's what was
 * making the global `::before` overshoot the bottom of the rail
 * previously. Gap between nodes is 12px and dots are 12px tall with
 * `top: 6px`, so dot-center sits at 12px and the connector needs to
 * reach 12px past the node's bottom (next dot center). */
.snapshots-rail-node:not(:last-child)::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 12px;
  height: calc(100% + 12px);
  width: 2px;
  background: var(--border);
  border-radius: 1px;
  z-index: 0;
}

.snapshots-rail-node {
  position: relative;
  padding-left: 24px;
  min-height: 12px;
}

/* Dot marker — solid 12px filled circle. Color reflects the trigger
 * semantic rather than chronological position, so the eye is drawn to
 * meaningful state-changing snapshots (update / restore) rather than
 * always to the newest entry. Variants:
 *   default snapshot   → neutral muted fill
 *   .is-state          → orange — post-update / post-restore
 *   .is-muted          → desaturated muted — copy events
 *   .is-pending        → dashed ring, no fill — Save CTA placeholder */
.snapshots-rail-dot {
  position: absolute;
  left: 0;
  top: 4px;
  width: 14px;
  height: 14px;
  border: none;
  z-index: 1;
  border-radius: 7px;
  border: 2px solid #262729;
  background: linear-gradient(0deg, #8a8a8a 0%, #8a8a8a 100%), #fd9903;
}

.snapshots-rail-dot.is-state {
  background: var(--warning);
  border-radius: 7px;
  border: 2px solid var(--color-surface);
}

.snapshots-rail-dot.is-muted {
  background: color-mix(in srgb, var(--text-muted) 55%, transparent);
}

.snapshots-rail-dot.is-pending {
  border-radius: 7px;
  border: 2px dashed var(--neutral-400);
  background: var(--titlebar-bg);
}

.snapshots-rail-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.snapshots-rail-save-box {
  display: flex;
  flex-direction: column;
  padding: 12px;
  border: 1px dashed var(--chooser-surface-border);
  border-radius: 8px;
}

.snapshots-rail-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  font-size: var(--takeover-fs-body);
  padding: 10px 14px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 100ms ease;
}

.snapshots-rail-cta:hover,
.snapshots-rail-cta:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.snapshots-rail-node.is-save .snapshots-rail-label {
  font-size: 12px;
  color: var(--neutral-100);
}

.snapshots-view-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: color-mix(in srgb, var(--surface) 60%, var(--titlebar-bg));
  border: 1px solid var(--border);
  border-top: none;
  border-radius: 0 0 10px 10px;
  margin-top: -4px;
}

.snapshots-view-detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border-hover);
}

.snapshots-view-detail-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  color: var(--neutral-100);
  cursor: pointer;
  transition:
    background-color 100ms ease,
    border-color 100ms ease;
}

.snapshots-view-detail-btn:hover,
.snapshots-view-detail-btn:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.snapshots-view-detail-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.snapshots-view-detail-btn.is-active {
  background: var(--brand-surface-bg-hover);
  border-color: color-mix(in oklab, var(--neutral-100) 28%, transparent);
}

.snapshots-view-detail-btn-danger {
  color: var(--danger);
}

.snapshots-view-detail-btn-danger:hover,
.snapshots-view-detail-btn-danger:focus-visible {
  color: var(--danger);
  border-color: var(--danger);
}

.snapshots-view-diff {
  /* Match the surrounding expanded-row surface — no second tint, no
   * box-in-a-box. The 1px hairline + radius are enough to delimit the
   * panel; tinted background made it the only filled block in the
   * expanded card and felt foreign. */
  padding: 10px 12px;
  margin-top: 8px;
  /* Cap at ~14 diff lines (12px/16px line-height) before the inner
   * pane starts scrolling — long diffs (100+ pip changes) otherwise
   * push the action row off-screen and force whole-drawer scroll. */
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--border-hover);
  border-radius: 8px;
  background: transparent;
}

.snapshots-view-diff-empty {
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
  font-style: italic;
}

.snapshots-view-diff-loading {
  padding: 8px 12px;
  margin-top: 8px;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

.snapshots-view-label {
  margin: 0 0 6px;
  font-size: var(--takeover-fs-caption);
  font-weight: 500;
  color: var(--text);
}

.snapshots-view-changes {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.snapshots-view-changes li {
  line-height: 16px;
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
