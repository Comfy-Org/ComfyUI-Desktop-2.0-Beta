<script setup lang="ts">
// TODO(stale-old-modal): delete after Settings drawer (v2,
// ComfyUISettingsPanel) reaches functional parity and ships everywhere.
import { ref, watch, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from '../composables/useModal'
import { useActionGuard } from '../composables/useActionGuard'
import { ChevronDown } from 'lucide-vue-next'
import { emitTelemetryAction, toCountBucket } from '../lib/telemetry'
import SnapshotInspector from './SnapshotInspector.vue'
import RestoreModal from './RestoreModal.vue'
import ImportPreviewModal from './ImportPreviewModal.vue'
import {
  triggerLabel as _triggerLabel,
  triggerClass,
  formatDate,
  formatRelative as _formatRelative,
  copyReasonLabel as _copyReasonLabel,
  changeSummary as _changeSummary,
  diffHasChanges,
} from '../lib/snapshots'
import type {
  ActionDef,
  CopyEvent,
  SnapshotSummary,
  SnapshotListData,
  SnapshotDetailData,
  SnapshotDiffData,
  SnapshotFilePreview,
} from '../types/ipc'

interface Props {
  installationId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'run-action': [action: ActionDef, button: HTMLButtonElement | null]
  'refresh-all': []
  'navigate-installation': [installationId: string]
}>()

const { t } = useI18n()
const modal = useModal()
const actionGuard = useActionGuard()

const listData = ref<SnapshotListData | null>(null)
const loading = ref(true)
const selectedFilename = ref<string | null>(null)
const detail = ref<SnapshotDetailData | null>(null)
const detailLoading = ref(false)
const diffData = ref<SnapshotDiffData | null>(null)
const diffLoading = ref(false)
const diffMode = ref<'previous' | 'current' | null>(null)
const restorePreviewFilename = ref<string | null>(null)
const restorePreviewDiff = ref<SnapshotDiffData | null>(null)
const restorePreviewLoading = ref(false)
const importPreview = ref<SnapshotFilePreview | null>(null)
const importPreviewLoading = ref(false)
// True when the restore modal is showing an import diff (no snapshots written yet).
const pendingImport = ref(false)

const snapshots = computed(() => listData.value?.snapshots ?? [])
const copyEvents = computed(() => listData.value?.copyEvents ?? [])
const context = computed(() => listData.value?.context ?? null)

type TimelineItem =
  | { kind: 'snapshot'; snapshot: SnapshotSummary; snapshotIndex: number }
  | { kind: 'copy'; event: CopyEvent }

const timelineItems = computed<TimelineItem[]>(() => {
  // Merge snapshots and copy events by timestamp, newest first.
  const items: TimelineItem[] = []
  let si = 0
  let ci = 0
  const snaps = snapshots.value
  const copies = [...copyEvents.value].sort((a, b) => new Date(b.copiedAt).getTime() - new Date(a.copiedAt).getTime())
  while (si < snaps.length || ci < copies.length) {
    const snapTime = si < snaps.length ? new Date(snaps[si]!.createdAt).getTime() : -Infinity
    const copyTime = ci < copies.length ? new Date(copies[ci]!.copiedAt).getTime() : -Infinity
    if (snapTime >= copyTime) {
      items.push({ kind: 'snapshot', snapshot: snaps[si]!, snapshotIndex: si })
      si++
    } else {
      items.push({ kind: 'copy', event: copies[ci]! })
      ci++
    }
  }
  return items
})

async function load(): Promise<void> {
  loading.value = true
  try {
    listData.value = await window.api.getSnapshots(props.installationId)
  } catch (err) {
    console.error('SnapshotTab.load failed', err)
  } finally {
    loading.value = false
  }
}

watch(() => props.installationId, () => {
  selectedFilename.value = null
  detail.value = null
  diffData.value = null
  diffMode.value = null
  restorePreviewFilename.value = null
  restorePreviewDiff.value = null
  importPreview.value = null
  importPreviewLoading.value = false
  pendingImport.value = false
  load()
}, { immediate: true })

const triggerLabel = (trigger: string): string => _triggerLabel(trigger, t)
const formatRelative = (iso: string): string => _formatRelative(iso, t)
const copyReasonLabel = (reason: string): string => _copyReasonLabel(reason, t)
const changeSummary = (s: SnapshotSummary): string[] => _changeSummary(s, t)

async function selectSnapshot(filename: string): Promise<void> {
  if (selectedFilename.value === filename) {
    selectedFilename.value = null
    detail.value = null
    diffData.value = null
    diffMode.value = null
    restorePreviewFilename.value = null
    restorePreviewDiff.value = null
    return
  }
  selectedFilename.value = filename
  diffData.value = null
  diffMode.value = null
  detailLoading.value = true
  try {
    detail.value = await window.api.getSnapshotDetail(props.installationId, filename)
  } finally {
    detailLoading.value = false
  }
}

async function loadDiff(mode: 'previous' | 'current'): Promise<void> {
  if (!selectedFilename.value) return
  if (diffMode.value === mode) {
    diffMode.value = null
    diffData.value = null
    return
  }
  diffMode.value = mode
  diffLoading.value = true
  try {
    diffData.value = await window.api.getSnapshotDiff(props.installationId, selectedFilename.value, mode)
  } finally {
    diffLoading.value = false
  }
}

async function saveSnapshot(): Promise<void> {
  const label = await modal.prompt({
    title: t('standalone.snapshotCreateTitle'),
    message: t('standalone.snapshotCreateMessage'),
    placeholder: t('standalone.snapshotLabelPlaceholder'),
    confirmLabel: t('snapshots.createSnapshot'),
    required: false,
  })
  if (label === null) return
  try {
    await window.api.runAction(props.installationId, 'snapshot-save', { label: label || undefined })
  } catch (err: unknown) {
    await modal.alert({ title: t('snapshots.createSnapshot'), message: (err as Error).message || String(err) })
    return
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'save',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
  })
  selectedFilename.value = null
  detail.value = null
  diffData.value = null
  diffMode.value = null
  await load()
  emit('refresh-all')
}

async function handleRestore(filename: string): Promise<void> {
  if (selectedFilename.value !== filename) {
    await selectSnapshot(filename)
  }
  // Load restore preview diff (current state → target snapshot).
  restorePreviewFilename.value = filename
  restorePreviewLoading.value = true
  try {
    restorePreviewDiff.value = await window.api.getSnapshotDiff(props.installationId, filename, 'current')
  } finally {
    restorePreviewLoading.value = false
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'restore_start',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    has_diff: restorePreviewDiff.value ? diffHasChanges(restorePreviewDiff.value.diff) : undefined,
  })
}

function cancelRestore(): void {
  restorePreviewFilename.value = null
  restorePreviewDiff.value = null
  pendingImport.value = false
}

async function confirmRestore(): Promise<void> {
  const hasDiff = restorePreviewDiff.value ? diffHasChanges(restorePreviewDiff.value.diff) : undefined
  let filename = restorePreviewFilename.value

  if (pendingImport.value) {
    // Import flow: write snapshots to disk now, then restore the newest.
    pendingImport.value = false
    restorePreviewFilename.value = null
    restorePreviewDiff.value = null

    // Gate the import-confirm step behind the busy guard — confirm
    // writes the staged snapshots into the install and immediately
    // auto-restores from the newest one, so racing an in-flight op
    // (copy / release-update / migrate / running launch) would clobber
    // both surfaces.
    if (!await actionGuard.checkBeforeAction(
      props.installationId,
      t('snapshots.importSnapshots'),
    )) return
    const result = await window.api.importSnapshotsConfirm(props.installationId)
    if (!result.ok) {
      if (result.message) {
        await modal.alert({ title: t('snapshots.importSnapshots'), message: result.message })
      }
      return
    }
    emitTelemetryAction('desktop2.snapshot.flow', {
      action: 'import',
      snapshot_count_bucket: toCountBucket(snapshots.value.length),
      imported_bucket: toCountBucket(result.imported ?? 0),
    })
    filename = result.restoreFile ?? null
    await load()
    emit('refresh-all')
  } else {
    restorePreviewFilename.value = null
    restorePreviewDiff.value = null
  }

  if (!filename) return

  const action: ActionDef = {
    id: 'snapshot-restore',
    label: t('standalone.snapshotRestore'),
    data: { file: filename },
    showProgress: true,
    progressTitle: t('standalone.snapshotRestoringTitle'),
    cancellable: true,
  }
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'restore_complete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    has_diff: hasDiff,
  })
  emit('run-action', action, null)
}

async function handleDelete(filename: string): Promise<void> {
  const confirmed = await modal.confirm({
    title: t('standalone.snapshotDelete'),
    message: t('snapshots.deleteConfirm'),
  })
  if (!confirmed) return
  await window.api.runAction(props.installationId, 'snapshot-delete', { file: filename })
  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'delete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
  })
  if (selectedFilename.value === filename) {
    selectedFilename.value = null
    detail.value = null
    diffData.value = null
    diffMode.value = null
  }
  await load()
  emit('refresh-all')
}

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

async function handleImport(): Promise<void> {
  importPreview.value = null
  const result = await window.api.importSnapshotsPreview()
  if (!result.ok) {
    if (result.message) {
      await modal.alert({ title: t('snapshots.importSnapshots'), message: result.message })
    }
    return
  }
  importPreview.value = result.preview ?? null
}

function cancelImportPreview(): void {
  importPreview.value = null
  importPreviewLoading.value = false
}

async function confirmImportPreview(): Promise<void> {
  importPreviewLoading.value = true
  const result = await window.api.importSnapshotsDiff(props.installationId)
  cancelImportPreview()
  if (!result.ok) {
    if (result.message) {
      await modal.alert({ title: t('snapshots.importSnapshots'), message: result.message })
    }
    return
  }

  // Hand the diff straight to the restore modal; nothing on disk until confirm.
  selectedFilename.value = null
  detail.value = null
  diffData.value = null
  diffMode.value = null
  pendingImport.value = true
  restorePreviewDiff.value = result.diff ?? null
  restorePreviewFilename.value = '__pending_import__'
}
</script>

<template>
  <div class="snapshot-tab">
    <div v-if="!loading && snapshots.length === 0" class="snapshot-empty">
      {{ t('snapshots.empty') }}
    </div>

    <div v-if="snapshots.length > 0 || !loading" class="snapshot-header">
      <button class="snapshot-save-btn" @click="saveSnapshot">
        {{ t('snapshots.createSnapshot') }}
      </button>
      <button class="snapshot-header-btn" @click="handleImport">
        {{ t('snapshots.importSnapshots') }}
      </button>
      <button v-if="snapshots.length > 0" class="snapshot-header-btn" @click="handleExportAll">
        {{ t('snapshots.exportAllSnapshots') }}
      </button>
    </div>

    <div v-if="loading" class="snapshot-loading with-spinner">{{ t('common.loading') }}</div>

    <div v-if="!loading && snapshots.length > 0" class="snapshot-timeline">
      <template v-for="(item, index) in timelineItems" :key="item.kind === 'snapshot' ? item.snapshot.filename : `copy-${item.event.installationId}`">
        <div v-if="item.kind === 'copy'" class="timeline-entry">
          <div class="timeline-gutter">
            <div class="timeline-line timeline-line-top" :class="{ invisible: index === 0 }" />
            <div class="timeline-dot trigger-copy" />
            <div class="timeline-line-rest" :class="{ invisible: index === timelineItems.length - 1 }" />
          </div>
          <div class="timeline-content">
            <div class="timeline-copy-card">
              <span class="timeline-trigger trigger-copy">{{ copyReasonLabel(item.event.copyReason) }}</span>
              <button
                v-if="item.event.exists"
                class="timeline-copy-name clickable"
                @click="emit('navigate-installation', item.event.installationId)"
              >{{ item.event.installationName }}</button>
              <span v-else class="timeline-copy-name">{{ item.event.installationName }}</span>
              <span class="timeline-time" :title="formatDate(item.event.copiedAt)">{{ formatRelative(item.event.copiedAt) }}</span>
            </div>
          </div>
        </div>

        <div
          v-else
          class="timeline-entry"
          :class="{ selected: selectedFilename === item.snapshot.filename }"
        >
          <div class="timeline-gutter">
            <div class="timeline-line timeline-line-top" :class="{ invisible: index === 0 }" />
            <div class="timeline-dot" :class="triggerClass(item.snapshot.trigger)" />
            <div class="timeline-line-rest" :class="{ invisible: index === timelineItems.length - 1 }" />
          </div>

          <div class="timeline-content">
            <div class="timeline-card" @click="selectSnapshot(item.snapshot.filename)">
              <div class="timeline-card-header">
                <span class="timeline-trigger" :class="triggerClass(item.snapshot.trigger)">{{ triggerLabel(item.snapshot.trigger) }}</span>
                <span v-if="item.snapshotIndex === 0" class="timeline-current-tag">{{ t('snapshots.current') }}</span>
                <span class="timeline-time" :title="formatDate(item.snapshot.createdAt)">{{ formatRelative(item.snapshot.createdAt) }}</span>
              </div>
              <div v-if="item.snapshot.label && !['after-update', 'before-update', 'after-restore'].includes(item.snapshot.label)" class="timeline-label">{{ item.snapshot.label }}</div>
              <div class="timeline-card-body">
                <div class="timeline-meta">
                  <span>{{ item.snapshot.comfyuiVersion }}</span>
                  <span class="timeline-meta-sep">·</span>
                  <span>{{ t('snapshots.nodesCount', { count: item.snapshot.nodeCount }) }}</span>
                  <span class="timeline-meta-sep">·</span>
                  <span>{{ t('snapshots.packagesCount', { count: item.snapshot.pipPackageCount }) }}</span>
                </div>
                <button
                  v-if="item.snapshotIndex > 0"
                  class="timeline-action-btn timeline-restore-btn"
                  @click.stop="handleRestore(item.snapshot.filename)"
                >
                  {{ t('snapshots.restore') }}
                </button>
                <button
                  class="timeline-action-btn timeline-export-btn"
                  @click.stop="handleExport(item.snapshot.filename)"
                >
                  {{ t('snapshots.exportSnapshot') }}
                </button>
                <button
                  v-if="item.snapshot.trigger === 'manual'"
                  class="timeline-action-btn timeline-delete-btn"
                  @click.stop="handleDelete(item.snapshot.filename)"
                >✕</button>
                <ChevronDown :size="14" class="timeline-expand-icon" :class="{ expanded: selectedFilename === item.snapshot.filename }" />
              </div>
              <div v-if="changeSummary(item.snapshot).length > 0" class="timeline-changes">
                <span v-for="part in changeSummary(item.snapshot)" :key="part" class="timeline-change-badge">{{ part }}</span>
              </div>
            </div>

            <SnapshotInspector
              v-if="selectedFilename === item.snapshot.filename"
              :detail="detail"
              :detail-loading="detailLoading"
              :diff-mode="diffMode"
              :diff-data="diffData"
              :diff-loading="diffLoading"
              :snapshot-index="item.snapshotIndex"
              :total-snapshots="snapshots.length"
              :context="context"
              @toggle-diff="loadDiff"
            />
          </div>
        </div>
      </template>
    </div>

    <RestoreModal
      v-if="restorePreviewFilename"
      :diff-data="restorePreviewDiff"
      :loading="restorePreviewLoading"
      @cancel="cancelRestore"
      @confirm="confirmRestore"
    />

    <ImportPreviewModal
      v-if="importPreview || importPreviewLoading"
      :preview="importPreview"
      :loading="importPreviewLoading"
      @cancel="cancelImportPreview"
      @confirm="confirmImportPreview"
    />
  </div>
</template>

<style scoped>
.snapshot-tab {
  padding: 8px 0;
}

.snapshot-header {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 4px 12px;
}

.snapshot-save-btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
  transition: all 0.15s;
}
.snapshot-save-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.snapshot-header-btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}
.snapshot-header-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.snapshot-empty {
  text-align: center;
  color: var(--text-muted);
  padding: 40px 20px;
  font-size: 14px;
}

.snapshot-loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 16px 0;
}

/* Timeline */
.snapshot-timeline {
  display: flex;
  flex-direction: column;
}

.timeline-entry {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 0 10px;
}

.timeline-gutter {
  grid-column: 1;
  grid-row: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.timeline-content {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
}

.timeline-line {
  width: 2px;
  background: var(--border);
}
.timeline-line-top {
  width: 2px;
  height: 16px;
  background: var(--border);
  flex-shrink: 0;
}
.timeline-line-rest {
  width: 2px;
  flex: 1;
  background: var(--border);
}
.timeline-line.invisible,
.timeline-line-top.invisible,
.timeline-line-rest.invisible {
  visibility: hidden;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-faint);
  border: 2px solid var(--surface);
  box-sizing: content-box;
}
.timeline-dot.trigger-boot { background: var(--text-muted); }
.timeline-dot.trigger-manual { background: var(--success); }
.timeline-dot.trigger-preupdate { background: var(--success); }
.timeline-dot.trigger-postupdate { background: var(--warning); }
.timeline-dot.trigger-postrestore { background: var(--warning); }
.timeline-dot.trigger-restart { background: var(--info); }
.timeline-dot.trigger-copy { background: var(--text-muted); }

.timeline-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: border-color 0.15s;
}
.timeline-card:hover {
  border-color: var(--border-hover);
}
.timeline-entry.selected .timeline-card {
  border-color: var(--selected);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-bottom-color: transparent;
  margin-bottom: 0;
}

.timeline-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.timeline-trigger {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg);
}
.timeline-trigger.trigger-boot { color: var(--text-muted); }
.timeline-trigger.trigger-manual { color: var(--success); }
.timeline-trigger.trigger-preupdate { color: var(--success); }
.timeline-trigger.trigger-postupdate { color: var(--warning); }
.timeline-trigger.trigger-postrestore { color: var(--warning); }
.timeline-trigger.trigger-restart { color: var(--info); }
.timeline-trigger.trigger-copy { color: var(--text-muted); }

.timeline-copy-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  margin-bottom: 6px;
  border-radius: 8px;
  border: 1px dashed var(--border);
  background: var(--surface);
  font-size: 12px;
}

.timeline-copy-name {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.timeline-copy-name.clickable {
  background: none;
  border: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.timeline-copy-name.clickable:hover {
  text-decoration: underline;
}

.timeline-current-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}

.timeline-time {
  font-size: 12px;
  color: var(--text-muted);
  margin-left: auto;
}

.timeline-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  margin-bottom: 4px;
}

.timeline-meta {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.timeline-meta-sep {
  color: var(--text-muted);
}

.timeline-changes {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.timeline-change-badge {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 3px;
}

.timeline-card-body {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline-action-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 4px;
  background: none;
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
  flex-shrink: 0;
}
.timeline-card:hover .timeline-action-btn,
.timeline-entry.selected .timeline-action-btn,
.timeline-action-btn:focus-visible {
  opacity: 1;
}
.timeline-restore-btn:hover,
.timeline-export-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}

.timeline-delete-btn {
  padding: 3px 6px;
  border-color: transparent;
  line-height: 1;
}
.timeline-delete-btn:hover {
  color: var(--danger);
  border-color: var(--danger);
}

.timeline-expand-icon {
  color: var(--text-muted);
  flex-shrink: 0;
  margin-left: auto;
  transition: transform 0.15s;
}
.timeline-expand-icon.expanded {
  transform: rotate(180deg);
}
.timeline-card:hover .timeline-expand-icon {
  color: var(--text-muted);
}
</style>
