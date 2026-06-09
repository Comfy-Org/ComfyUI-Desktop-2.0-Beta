<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Download, RotateCcw, Trash2, Upload } from 'lucide-vue-next'
import { TID } from '../../../../shared/testIds'
import { useDialogs } from '../../composables/useDialogs'
import { useActionGuard } from '../../composables/useActionGuard'
import { emitTelemetryAction, toCountBucket } from '../../lib/telemetry'
import {
  diffHasChanges,
  formatDate,
  formatRelative as _formatRelative,
  getCachedSnapshotList,
  setCachedSnapshotList,
  triggerLabel
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
import BaseAccordion from '../../components/ui/BaseAccordion.vue'
import { humanizeOpStatus } from '../../lib/progressStatusLabel'

interface ActiveOperation {
  percent: number
  status: string
  done: boolean
  ok: boolean | null
  error: string | null
  actionId: string
  actionData?: Record<string, unknown>
}

/** Snapshots tab body: save / restore / delete / export / import.
 *  Presentational + IPC-glue only; restore runs through `show-progress`
 *  so PanelApp's ProgressModal owns the long-running op. */

interface Props {
  installationId: string
  /** Live background-op status, used to mark the restoring row and lock
   *  out the others. */
  activeOperation?: ActiveOperation | null
}

const props = withDefaults(defineProps<Props>(), { activeOperation: null })

const emit = defineEmits<{
  /** Fires when restore commits; the host routes it through the
   *  show-progress flow. */
  'run-action': [action: ActionDef]
  /** Lets the host re-load sections after a snapshot op. */
  'refresh-all': []
  /** Cancel / retry / dismiss for the inline top-card restore op. */
  'op-cancel': []
  'op-retry': []
  'op-dismiss': []
}>()

const { t } = useI18n()
const dialogs = useDialogs()
const actionGuard = useActionGuard()

const listData = ref<SnapshotListData | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

const snapshots = computed<SnapshotSummary[]>(() => listData.value?.snapshots ?? [])
const copyEvents = computed<CopyEvent[]>(() => listData.value?.copyEvents ?? [])

// Restore feedback card in the "Save New Snapshot" slot at the top of the
// rail: ok → success (auto-dismiss + reload), error → retry/dismiss,
// cancelled → disappears.
const restoreOp = computed<ActiveOperation | null>(() => {
  const op = props.activeOperation
  return op && op.actionId === 'snapshot-restore' ? op : null
})
const restoreOpFile = computed<string | null>(
  () => (restoreOp.value?.actionData as { file?: string } | undefined)?.file ?? null
)
const restoreInFlight = computed<boolean>(() => !!restoreOp.value && !restoreOp.value.done)
const restorePhase = computed<string>(() => {
  const op = restoreOp.value
  if (!op || op.done) return ''
  return humanizeOpStatus(op.status, t)
})
const restorePercent = computed<number | null>(() => {
  const p = restoreOp.value?.percent ?? -1
  return p < 0 ? null : Math.max(0, Math.min(100, p))
})
const restoreCancellable = computed<boolean>(
  () =>
    !!restoreOp.value &&
    !restoreOp.value.done &&
    ((restoreOp.value as ActiveOperation & { cancellable?: boolean }).cancellable ?? false)
)

/** Label for the snapshot being restored to. Falls back to the filename
 *  when the row isn't loaded locally yet. */
const restoreFromLabel = computed<string>(() => {
  const file = restoreOpFile.value
  if (!file) return ''
  const target = snapshots.value.find((s) => s.filename === file)
  if (target) {
    const trigger = triggerLabel(target.trigger, t)
    const when = _formatRelative(target.createdAt, t)
    return target.label ? `${target.label} · ${when}` : `${trigger} · ${when}`
  }
  return file
})

// Latched terminal state so the card keeps the right copy until dismissed.
const restoreTerminal = ref<'ok' | 'error' | null>(null)
const restoreErrorMessage = ref<string>('')
let restoreOkTimer: ReturnType<typeof setTimeout> | null = null
function clearRestoreTerminal(): void {
  if (restoreOkTimer !== null) {
    clearTimeout(restoreOkTimer)
    restoreOkTimer = null
  }
  restoreTerminal.value = null
  restoreErrorMessage.value = ''
}
function dismissRestoreCard(): void {
  clearRestoreTerminal()
  emit('op-dismiss')
}
function cancelRestore(): void {
  emit('op-cancel')
}
function retryRestore(): void {
  clearRestoreTerminal()
  emit('op-retry')
}
watch(restoreOp, (op, prev) => {
  if (!op) return
  // In-flight → done transition only.
  if (!op.done || (prev && prev.done)) return
  if (op.ok) {
    clearRestoreTerminal()
    restoreTerminal.value = 'ok'
    restoreOkTimer = setTimeout(() => {
      restoreTerminal.value = null
      restoreOkTimer = null
      // Reload so the post-restore snapshot lands as the newest entry.
      void load()
      emit('refresh-all')
      emit('op-dismiss')
    }, 1800)
  } else if (op.error === 'Cancelled.') {
    clearRestoreTerminal()
  } else {
    clearRestoreTerminal()
    restoreTerminal.value = 'error'
    restoreErrorMessage.value = op.error ?? ''
  }
})
onUnmounted(() => {
  clearRestoreTerminal()
  unsubChanges?.()
  if (reloadTimer) clearTimeout(reloadTimer)
})

const showRestoreCard = computed<boolean>(
  () => restoreInFlight.value || restoreTerminal.value !== null
)

// Scroll to the top card when an op begins so it's not missed deep in the timeline.
const topCardRef = ref<HTMLElement | null>(null)
watch(restoreInFlight, (yes) => {
  if (!yes) return
  void nextTick(() => {
    topCardRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
})

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

/** "Latest: 8d ago" stat from the newest snapshot; null when none. Copy
 * events are excluded so an interleaved "Copied from/as X" entry can't hijack
 * the stat (see issue #1007). */
const latestRelative = computed<string | null>(() => {
  const newest = snapshots.value[0]
  if (!newest) return null
  return _formatRelative(newest.createdAt, t)
})

function autoExpandFirst(): void {
  if (expandedFilenames.value.size > 0) return
  const newest = snapshots.value[0]
  if (newest) {
    expandedFilenames.value = new Set([newest.filename])
  }
}

async function load(silent = false): Promise<void> {
  // `silent` = background refresh: keep the current list visible (no
  // Loading… flash, no auto-expand) while refetching in place.
  if (!silent) loading.value = true
  loadError.value = null
  try {
    const data = await window.api.getSnapshots(props.installationId)
    listData.value = data
    // Cache so the next remount paints instantly.
    setCachedSnapshotList(props.installationId, data)
  } catch (err: unknown) {
    // Surface IPC rejections so "load failed" is distinguishable from "none".
    if (!silent) {
      loadError.value = (err as Error)?.message ?? String(err)
      listData.value = null
    }
    console.error('SnapshotsView.load failed', err)
  } finally {
    if (!silent) loading.value = false
    if (!silent) autoExpandFirst()
  }
}

// Live refresh on `installations-changed`, debounced so a burst of pushes
// collapses into a single silent reload.
let unsubChanges: (() => void) | undefined
let reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void load(true)
  }, 250)
}
onMounted(() => {
  const onChanged = (window.api as { onInstallationsChanged?: (cb: () => void) => () => void })
    .onInstallationsChanged
  if (typeof onChanged === 'function') {
    unsubChanges = onChanged(() => scheduleReload())
  }
})

// --- Per-row expansion (change summary) ---

const expandedFilenames = ref<Set<string>>(new Set())

// Two diff accordions per snapshot, keyed `${filename}|${mode}`:
// `previous` = changes vs the prior snapshot; `current` = restore preview
// vs live state. `diffCache` presence = loaded.
type DiffMode = 'previous' | 'current'
const diffCache = ref<Map<string, SnapshotDiffData | null>>(new Map())
const openDiffs = ref<Set<string>>(new Set())
const diffLoading = ref<Set<string>>(new Set())
const dkey = (filename: string, mode: DiffMode): string => `${filename}|${mode}`

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

function isDiffOpen(filename: string, mode: DiffMode): boolean {
  return openDiffs.value.has(dkey(filename, mode))
}
function isDiffLoading(filename: string, mode: DiffMode): boolean {
  return diffLoading.value.has(dkey(filename, mode))
}
function diffFor(filename: string, mode: DiffMode): SnapshotDiffData | null | undefined {
  return diffCache.value.get(dkey(filename, mode))
}

async function toggleDiff(filename: string, mode: DiffMode): Promise<void> {
  const key = dkey(filename, mode)
  if (openDiffs.value.has(key)) {
    const next = new Set(openDiffs.value)
    next.delete(key)
    openDiffs.value = next
    return
  }
  const opened = new Set(openDiffs.value)
  opened.add(key)
  openDiffs.value = opened
  if (diffCache.value.has(key)) return
  diffLoading.value = new Set(diffLoading.value).add(key)
  try {
    const d = await window.api.getSnapshotDiff(props.installationId, filename, mode)
    diffCache.value = new Map(diffCache.value).set(key, d)
    emitTelemetryAction('comfy.desktop.snapshot.flow', {
      action: 'view_diff',
      snapshot_count_bucket: toCountBucket(snapshots.value.length),
      has_diff: d ? diffHasChanges(d.diff) : undefined
    })
  } finally {
    const next = new Set(diffLoading.value)
    next.delete(key)
    diffLoading.value = next
  }
}

watch(
  () => props.installationId,
  (id) => {
    expandedFilenames.value = new Set()
    diffCache.value = new Map()
    openDiffs.value = new Set()
    diffLoading.value = new Set()
    const cached = getCachedSnapshotList(id)
    if (cached) {
      // Paint the cached list instantly, then refresh silently.
      listData.value = cached
      loading.value = false
      loadError.value = null
      autoExpandFirst()
      void load(true)
    } else {
      void load()
    }
  },
  { immediate: true }
)

// --- Save ---

async function handleSave(): Promise<void> {
  const label = await dialogs.prompt({
    title: t('standalone.snapshotCreateTitle'),
    message: t('standalone.snapshotCreateMessage'),
    placeholder: t('standalone.snapshotLabelPlaceholder'),
    confirmLabel: t('snapshots.createSnapshot'),
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
  emitTelemetryAction('comfy.desktop.snapshot.flow', {
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
  const hasChanges = diff ? diffHasChanges(diff.diff) : undefined

  emitTelemetryAction('comfy.desktop.snapshot.flow', {
    action: 'restore_complete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    has_diff: hasChanges
  })

  // Pass the diff-preview confirm through so `runAction` augments it with
  // the willStopRunning warning rather than synthesizing a second modal.
  emit('run-action', {
    id: 'snapshot-restore',
    label: t('standalone.snapshotRestore', 'Restore'),
    data: { file: filename },
    showProgress: true,
    progressTitle: t('standalone.snapshotRestoringTitle', 'Restoring snapshot'),
    cancellable: true,
    style: 'primary',
    confirm: {
      title: t('snapshots.restoreConfirmTitle'),
      message: t('snapshots.restoreConfirmMessage'),
      restoreDiff: diff?.diff ?? null,
      confirmLabel: t('standalone.snapshotRestore', 'Restore')
    }
  })
}

// --- Delete ---

async function handleDelete(filename: string): Promise<void> {
  const target = snapshots.value.find((s) => s.filename === filename)
  const displayName = target?.label || target?.filename || ''
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
  emitTelemetryAction('comfy.desktop.snapshot.flow', {
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
  emitTelemetryAction('comfy.desktop.snapshot.flow', {
    action: 'export_one',
    snapshot_count_bucket: toCountBucket(snapshots.value.length)
  })
}

async function handleExportAll(): Promise<void> {
  await window.api.exportAllSnapshots(props.installationId)
  emitTelemetryAction('comfy.desktop.snapshot.flow', {
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

  // Step 3: confirm restore. Gate behind the busy guard — confirm writes
  // the staged snapshots and auto-restores, so racing an in-flight op
  // would clobber both surfaces.
  if (
    !(await actionGuard.checkBeforeAction(
      props.installationId,
      t('snapshots.importSnapshots', 'Import Snapshots')
    ))
  )
    return
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
  emitTelemetryAction('comfy.desktop.snapshot.flow', {
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
      cancellable: true,
      style: 'primary'
    })
  }
}
</script>

<template>
  <div class="snapshots-view">
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
      <button type="button" class="snapshots-view-toolbtn" @click="load()">
        {{ t('common.retry', 'Retry') }}
      </button>
    </div>

    <!-- Timeline rail: first node is the "Save New Snapshot" CTA, then
         snapshots + copy events, newest first. -->
    <ul class="snapshots-rail" :class="{ 'is-empty': timeline.length === 0 }">
      <li
        ref="topCardRef"
        class="snapshots-rail-node is-save"
        :class="{
          'is-op-inflight': restoreInFlight,
          'is-op-success': restoreTerminal === 'ok',
          'is-op-error': restoreTerminal === 'error'
        }"
      >
        <span
          class="snapshots-rail-dot"
          :class="{
            'is-pending': !showRestoreCard,
            'is-spinning': restoreInFlight,
            'is-restored': restoreTerminal === 'ok',
            'is-error': restoreTerminal === 'error'
          }"
          :aria-hidden="true"
        ></span>
        <div class="snapshots-rail-content">
          <span class="snapshots-rail-label">
            <template v-if="restoreInFlight">{{
              t('snapshots.restoringStatus', 'Restoring snapshot')
            }}</template>
            <template v-else-if="restoreTerminal === 'ok'">{{
              t('snapshots.restored', 'Snapshot restored')
            }}</template>
            <template v-else-if="restoreTerminal === 'error'">{{
              t('snapshots.restoreFailed', 'Restore failed')
            }}</template>
            <template v-else>{{ t('snapshots.createLabel', 'Create Snapshot') }}</template>
          </span>
          <div
            class="snapshots-rail-save-box"
            :class="{
              'is-op-inflight': restoreInFlight,
              'is-op-success': restoreTerminal === 'ok',
              'is-op-error': restoreTerminal === 'error'
            }"
          >
            <div
              v-if="restoreInFlight"
              class="snapshots-op-card"
              role="status"
              aria-live="polite"
              :data-testid="TID.snapshotsOpCard"
            >
              <p v-if="restoreFromLabel" class="snapshots-op-card-target">
                {{ t('snapshots.restoringFrom', { label: restoreFromLabel }) }}
              </p>
              <div
                class="snapshots-op-bar-wrap"
                role="progressbar"
                :aria-valuenow="restorePercent ?? undefined"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <div class="snapshots-op-bar-header">
                  <span class="snapshots-op-bar-status">{{ restorePhase }}</span>
                  <span v-if="restorePercent !== null" class="snapshots-op-bar-pct">
                    {{ restorePercent }}%
                  </span>
                </div>
                <div class="snapshots-op-bar-track">
                  <div
                    class="snapshots-op-bar-fill"
                    :class="{ 'is-indeterminate': restorePercent === null }"
                    :style="restorePercent === null ? {} : { width: `${restorePercent}%` }"
                  />
                </div>
              </div>
              <button
                v-if="restoreCancellable"
                type="button"
                class="snapshots-op-ghost-btn"
                :data-testid="TID.snapshotsOpCardCancel"
                @click="cancelRestore"
              >
                {{ t('common.cancel', 'Cancel') }}
              </button>
            </div>

            <!-- Success: auto-dismisses after ~1.8s. -->
            <div
              v-else-if="restoreTerminal === 'ok'"
              class="snapshots-op-card is-success"
              role="status"
              :data-testid="TID.snapshotsOpCard"
            >
              <p v-if="restoreFromLabel" class="snapshots-op-card-target">
                {{ t('snapshots.restoredFrom', { label: restoreFromLabel }) }}
              </p>
            </div>

            <!-- Error: persistent until user dismisses. -->
            <div
              v-else-if="restoreTerminal === 'error'"
              class="snapshots-op-card is-error"
              role="alert"
              :data-testid="TID.snapshotsOpCard"
            >
              <p v-if="restoreErrorMessage" class="snapshots-op-card-error-msg">
                {{ restoreErrorMessage }}
              </p>
              <div class="snapshots-op-actions">
                <button
                  type="button"
                  class="snapshots-op-primary-btn"
                  :data-testid="TID.snapshotsOpCardRetry"
                  @click="retryRestore"
                >
                  {{ t('snapshots.tryAgain', 'Try again') }}
                </button>
                <button
                  type="button"
                  class="snapshots-op-ghost-btn"
                  :data-testid="TID.snapshotsOpCardDismiss"
                  @click="dismissRestoreCard"
                >
                  {{ t('common.dismiss', 'Dismiss') }}
                </button>
              </div>
            </div>

            <!-- Idle: the Save CTA. -->
            <button
              v-else
              type="button"
              class="snapshots-rail-cta"
              :aria-label="t('snapshots.createSnapshot', 'Create Snapshot')"
              @click="handleSave"
            >
              <span>{{ t('snapshots.createNew', 'Create Snapshot') }}</span>
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
          'is-copy': item.kind === 'copy'
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
              :is-latest="item.snapshotIndex === 0"
              :previous-comfyui-version="snapshots[item.snapshotIndex + 1]?.comfyuiVersion"
              :toggle-test-id="TID.snapshotRow(item.snapshot.filename)"
              @toggle="toggleExpand(item.snapshot.filename)"
            >
              <template #expanded>
                <p v-if="item.snapshot.label" class="snapshots-view-label">
                  {{ item.snapshot.label }}
                </p>

                <!-- "Release notes": changes vs the previous snapshot.
                     Hidden for the oldest snapshot (no predecessor); copy
                     events interleaved in the timeline don't count. -->
                <div
                  v-if="item.snapshotIndex < snapshots.length - 1"
                  class="snap-diff-accordion"
                >
                  <button
                    type="button"
                    class="snap-diff-trigger"
                    :class="{ 'is-open': isDiffOpen(item.snapshot.filename, 'previous') }"
                    :aria-expanded="isDiffOpen(item.snapshot.filename, 'previous')"
                    @click="toggleDiff(item.snapshot.filename, 'previous')"
                  >
                    <ChevronDown :size="13" class="snap-diff-chevron" />
                    <span>{{
                      t('snapshots.changesInSnapshot', 'What changed in this snapshot')
                    }}</span>
                  </button>
                  <BaseAccordion :open="isDiffOpen(item.snapshot.filename, 'previous')">
                    <div class="snapshots-view-diff">
                      <div
                        v-if="isDiffLoading(item.snapshot.filename, 'previous')"
                        class="snapshots-view-diff-loading"
                      >
                        {{ t('common.loading', 'Loading…') }}
                      </div>
                      <template
                        v-else-if="diffFor(item.snapshot.filename, 'previous') !== undefined"
                      >
                        <div
                          v-if="
                            !diffFor(item.snapshot.filename, 'previous') ||
                            !diffHasChanges(diffFor(item.snapshot.filename, 'previous')!.diff)
                          "
                          class="snapshots-view-diff-empty"
                        >
                          {{
                            t('snapshots.diffNoChanges', 'No changes from the previous snapshot.')
                          }}
                        </div>
                        <SnapshotDiffView
                          v-else
                          :diff="diffFor(item.snapshot.filename, 'previous')!.diff"
                        />
                      </template>
                    </div>
                  </BaseAccordion>
                </div>

                <!-- "Restore preview": changes vs live state. Hidden for the
                     newest snapshot (restoring it is a no-op); copy events
                     interleaved in the timeline don't count. -->
                <div v-if="item.snapshotIndex !== 0" class="snap-diff-accordion">
                  <button
                    type="button"
                    class="snap-diff-trigger"
                    :class="{ 'is-open': isDiffOpen(item.snapshot.filename, 'current') }"
                    :aria-expanded="isDiffOpen(item.snapshot.filename, 'current')"
                    @click="toggleDiff(item.snapshot.filename, 'current')"
                  >
                    <ChevronDown :size="13" class="snap-diff-chevron" />
                    <span>{{
                      t('snapshots.ifYouRestore', 'What restoring this would change')
                    }}</span>
                  </button>
                  <BaseAccordion :open="isDiffOpen(item.snapshot.filename, 'current')">
                    <div class="snapshots-view-diff">
                      <div
                        v-if="isDiffLoading(item.snapshot.filename, 'current')"
                        class="snapshots-view-diff-loading"
                      >
                        {{ t('common.loading', 'Loading…') }}
                      </div>
                      <template
                        v-else-if="diffFor(item.snapshot.filename, 'current') !== undefined"
                      >
                        <div
                          v-if="
                            !diffFor(item.snapshot.filename, 'current') ||
                            !diffHasChanges(diffFor(item.snapshot.filename, 'current')!.diff)
                          "
                          class="snapshots-view-diff-empty"
                        >
                          {{
                            t(
                              'snapshots.restoreNoChanges',
                              'Restoring this would make no changes — it matches your current state.'
                            )
                          }}
                        </div>
                        <SnapshotDiffView
                          v-else
                          :diff="diffFor(item.snapshot.filename, 'current')!.diff"
                        />
                      </template>
                    </div>
                  </BaseAccordion>
                </div>

                <!-- Actions live in the expanded detail so the collapsed
                     row stays a clean tap target. -->
                <div class="snapshots-view-detail-actions">
                  <button
                    v-if="item.snapshotIndex !== 0"
                    type="button"
                    class="snapshots-view-detail-btn"
                    :aria-label="t('snapshots.restore', 'Restore')"
                    :data-testid="TID.snapshotRowRestore(item.snapshot.filename)"
                    :disabled="restoreInFlight"
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
                    :disabled="restoreInFlight"
                    @click="handleExport(item.snapshot.filename)"
                  >
                    <Download :size="13" />
                    <span>{{ t('snapshots.exportSnapshot', 'Export') }}</span>
                  </button>
                  <button
                    type="button"
                    class="snapshots-view-detail-btn snapshots-view-detail-btn-danger"
                    :aria-label="t('snapshots.delete', 'Delete')"
                    :disabled="restoreInFlight"
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
            <span class="snapshots-view-copy-icon" :aria-hidden="true">{{
              item.event.direction === 'in' ? '←' : '→'
            }}</span>
            <span class="snapshots-view-copy-label">
              {{
                item.event.direction === 'in'
                  ? t('snapshots.copyEventLabelIncoming', {
                      source: item.event.installationName || item.event.installationId
                    })
                  : t('snapshots.copyEventLabel', {
                      destination: item.event.installationName || item.event.installationId
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

.snapshots-rail {
  list-style: none;
  margin: 0;
  padding: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* Per-node connector from this dot's center to the next. Last node has
 * none, so the rail doesn't overshoot the bottom. */
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

/* Dot marker. Color reflects the trigger semantic: .is-state = orange
 * (post-update/restore), .is-muted = copy events, .is-pending = Save CTA. */
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

/* Restore in-flight — rotating conic ring, matching the picker row's spinner. */
.snapshots-rail-dot.is-spinning {
  background: conic-gradient(var(--brand-accent, #f5c518) 270deg, transparent 270deg);
  border: 2px solid var(--color-surface);
  animation: snapshots-rail-dot-spin 0.8s linear infinite;
}
.snapshots-rail-dot.is-restored {
  background: var(--success, #34c759);
  border: 2px solid var(--color-surface);
}
.snapshots-rail-dot.is-error {
  background: var(--danger, #ef4444);
  border: 2px solid var(--color-surface);
}
@keyframes snapshots-rail-dot-spin {
  to {
    transform: rotate(360deg);
  }
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
  padding: 10px 12px;
  margin-top: 8px;
  /* Cap height so long diffs scroll internally instead of pushing the
   * action row off-screen. */
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
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

.snap-diff-accordion {
  display: flex;
  flex-direction: column;
  margin-top: 8px;
}
.snap-diff-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 2px 4px 2px 0;
  background: transparent;
  border: none;
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.snap-diff-trigger:hover,
.snap-diff-trigger:focus-visible {
  color: var(--text);
  outline: none;
}
.snap-diff-chevron {
  color: var(--text-muted);
  transition: transform 180ms cubic-bezier(0.4, 0, 0.2, 1);
}
.snap-diff-trigger.is-open .snap-diff-chevron {
  transform: rotate(180deg);
}
.snap-diff-accordion .snapshots-view-diff {
  margin-top: 6px;
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

/* Top-card restore feedback: in-flight (percent bar), success (green
 * tint), error (red tint). */
.snapshots-rail-save-box.is-op-inflight,
.snapshots-rail-save-box.is-op-success,
.snapshots-rail-save-box.is-op-error {
  border-style: solid;
  padding: 14px;
}
.snapshots-rail-save-box.is-op-success {
  border-color: var(--success, #34c759);
  background: color-mix(in srgb, var(--success, #34c759) 8%, transparent);
}
.snapshots-rail-save-box.is-op-error {
  border-color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent);
}

.snapshots-op-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.snapshots-op-card-target {
  margin: 0;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}
.snapshots-op-bar-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.snapshots-op-bar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--takeover-fs-caption);
}
.snapshots-op-bar-status {
  color: var(--neutral-100);
}
.snapshots-op-bar-pct {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.snapshots-op-bar-track {
  position: relative;
  height: 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--neutral-100) 8%, transparent);
  overflow: hidden;
}
.snapshots-op-bar-fill {
  height: 100%;
  background: var(--brand-accent, #f5c518);
  transition: width 120ms ease;
}
.snapshots-op-bar-fill.is-indeterminate {
  width: 40%;
  animation: snapshots-op-bar-indet 1.2s ease-in-out infinite;
}
@keyframes snapshots-op-bar-indet {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

.snapshots-op-card-error-msg {
  margin: 0;
  font-size: var(--takeover-fs-caption);
  color: var(--danger, #ef4444);
  /* `pre-wrap` preserves the action's multi-line detail; capped height
   * keeps a long failure list from pushing the actions off-screen. */
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 168px;
  overflow-y: auto;
  text-align: left;
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: 1.45;
}
.snapshots-op-actions {
  display: flex;
  gap: 8px;
}
.snapshots-op-primary-btn,
.snapshots-op-ghost-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 100ms ease;
}
.snapshots-op-primary-btn {
  background: var(--brand-accent, #f5c518);
  color: #1a1a1a;
  border: 1px solid var(--brand-accent, #f5c518);
}
.snapshots-op-primary-btn:hover,
.snapshots-op-primary-btn:focus-visible {
  background: color-mix(in srgb, var(--brand-accent, #f5c518) 88%, white);
  outline: none;
}
.snapshots-op-ghost-btn {
  background: transparent;
  color: var(--neutral-100);
  border: 1px solid var(--chooser-surface-border);
}
.snapshots-op-ghost-btn:hover,
.snapshots-op-ghost-btn:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
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
