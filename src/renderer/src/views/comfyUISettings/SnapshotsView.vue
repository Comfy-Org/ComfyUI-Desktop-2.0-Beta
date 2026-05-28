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
  /** Live background-op status for this install — surfaced by the
   *  picker's inline-progress path. Used to mark the restoring row in
   *  the timeline with a spinner + status string, show a brief "Restored"
   *  chip on success, and lock out row actions on the other rows. */
  activeOperation?: ActiveOperation | null
}

const props = withDefaults(defineProps<Props>(), { activeOperation: null })

const emit = defineEmits<{
  /** Fires when restore commits — parent (drawer) routes through
   *  `useComfyUISettings.runAction` so the standard show-progress
   *  flow (ProgressModal in PanelApp) handles the long-running op. */
  'run-action': [action: ActionDef]
  /** Lets the drawer host re-load sections after a snapshot op (e.g.
   *  restore navigates back to install detail with refreshed state). */
  'refresh-all': []
  /** Cancel / retry / dismiss for the inline top-card restore op.
   *  Bubbles up to `ComfyUISettingsContent` which already relays these
   *  to the picker's bridge methods. */
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

// --- Restore feedback (driven by the picker's inline-progress path) ---
// Surfaces as a single prominent card in the dashed "Save New Snapshot"
// slot at the top of the rail, in front of the user's eyes. Three
// terminal-state branches:
//   - ok        → "Snapshot restored" success card, auto-dismisses after
//                 a beat and reloads the list (the post-restore snapshot
//                 lands as the new newest entry below).
//   - error     → red card with the message + Retry / Dismiss actions.
//   - cancelled → card disappears (op snapshot keeps the entry around
//                 for 15s but we treat cancelled as user-driven dismissal).
const restoreOp = computed<ActiveOperation | null>(() => {
  const op = props.activeOperation
  return op && op.actionId === 'snapshot-restore' ? op : null
})
const restoreOpFile = computed<string | null>(
  () => (restoreOp.value?.actionData as { file?: string } | undefined)?.file ?? null
)
const restoreInFlight = computed<boolean>(
  () => !!restoreOp.value && !restoreOp.value.done
)
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
  () => !!restoreOp.value && !restoreOp.value.done
       && ((restoreOp.value as ActiveOperation & { cancellable?: boolean }).cancellable ?? false)
)

/** "Updated · 1h ago"-style label for the snapshot being restored *to* —
 *  echoes how rows render below so the user sees the exact target. Falls
 *  back to the user-provided label or the filename if we don't have the
 *  row locally (e.g. picker fired the action before sections loaded). */
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

// Latched terminal-state for the top card. `null` means the card sits
// in-flight; on done we capture the outcome here so the card stays
// rendered with the right copy until the user dismisses (or the success
// timer fires).
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
      // Reload so the new "post-restore" snapshot (written by the
      // restore pipeline) lands as the newest entry; emit `op-dismiss`
      // so main clears `_activeOperationStatus` and the picker's
      // local seed.
      void load()
      emit('refresh-all')
      emit('op-dismiss')
    }, 1800)
  } else if (op.error === 'Cancelled.') {
    // User dismissed it themselves — drop the card without fanfare.
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

// Pull the user up to the top card when an op begins, so a user scrolled
// deep in the timeline sees the card without hunting for it. Uses
// `block: 'start'` because the card is the top item and we want the
// header just below the chrome.
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

/** Header "Latest: 8d ago" stat — derives from the newest timeline
 *  item (snapshot OR copy event). null when there's nothing yet. */
const latestRelative = computed<string | null>(() => {
  const first = timeline.value[0]
  if (!first) return null
  const iso = first.kind === 'snapshot' ? first.snapshot.createdAt : first.event.copiedAt
  return _formatRelative(iso, t)
})

function autoExpandFirst(): void {
  if (expandedFilenames.value.size > 0) return
  const firstSnapshot = timeline.value.find(
    (item): item is Extract<TimelineItem, { kind: 'snapshot' }> => item.kind === 'snapshot'
  )
  if (firstSnapshot) {
    expandedFilenames.value = new Set([firstSnapshot.snapshot.filename])
  }
}

async function load(silent = false): Promise<void> {
  // `silent` = background refresh (auto-refresh or post-cache-seed): keep the
  // current list visible (no "Loading…" flash, no auto-expand) while we
  // refetch in place.
  if (!silent) loading.value = true
  loadError.value = null
  try {
    const data = await window.api.getSnapshots(props.installationId)
    listData.value = data
    // Cache so the next remount of this tab paints instantly (no layout shift).
    setCachedSnapshotList(props.installationId, data)
  } catch (err: unknown) {
    // Surface IPC rejections — the legacy SnapshotTab swallows these
    // silently and we can't tell "no snapshots" from "load failed".
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

// Live refresh: re-load when the snapshot set changes underneath us — e.g.
// the user installs a custom node and ComfyUI writes a new snapshot while the
// Snapshots tab is the last-open one. In the drawer this rides
// `installations-changed`; in the IPP the picker shim maps the same hook onto
// the picker's snapshot rebroadcast. Debounced so a burst of pushes (op
// progress) collapses into a single silent reload.
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
  const onChanged = (
    window.api as { onInstallationsChanged?: (cb: () => void) => () => void }
  ).onInstallationsChanged
  if (typeof onChanged === 'function') {
    unsubChanges = onChanged(() => scheduleReload())
  }
})

// --- Per-row expansion (change summary) ---

const expandedFilenames = ref<Set<string>>(new Set())

/**
 * Two diff accordions per expanded snapshot, keyed by `${filename}|${mode}`:
 *   - `previous` — what changed FROM the previous snapshot TO this one
 *     (a "release notes" view of the snapshot itself).
 *   - `current`  — what would change if you RESTORE this snapshot from the
 *     live install state (the restore preview).
 * `diffCache` presence = loaded (value may be null/empty); `openDiffs` =
 * accordion expanded; `diffLoading` = fetch in flight.
 */
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
    emitTelemetryAction('desktop2.snapshot.flow', {
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
      // Paint the last-known list instantly (no empty-state flash / layout
      // shift on tab remount), then refresh silently in the background.
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
  const hasChanges = diff ? diffHasChanges(diff.diff) : undefined

  emitTelemetryAction('desktop2.snapshot.flow', {
    action: 'restore_complete',
    snapshot_count_bucket: toCountBucket(snapshots.value.length),
    has_diff: hasChanges
  })

  // Pass the diff-preview confirm through the emit so
  // `useComfyUISettings.runAction` step 3 augments this existing
  // confirm with the `willStopRunning` warning instead of synthesizing
  // a second one. Single modal whether the install is running or not.
  // `restoreDiff` renders the same SnapshotDiffView the Snapshots tab uses,
  // as a collapsible accordion in the confirm (node/pip sections collapse so
  // a large diff doesn't overflow the modal).
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
      cancellable: true,
      style: 'primary'
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
      <button type="button" class="snapshots-view-toolbtn" @click="load()">
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
      <li
        ref="topCardRef"
        class="snapshots-rail-node is-save"
        :class="{
          'is-op-inflight':  restoreInFlight,
          'is-op-success':   restoreTerminal === 'ok',
          'is-op-error':     restoreTerminal === 'error'
        }"
      >
        <span
          class="snapshots-rail-dot"
          :class="{
            'is-pending':  !showRestoreCard,
            'is-spinning': restoreInFlight,
            'is-restored': restoreTerminal === 'ok',
            'is-error':    restoreTerminal === 'error'
          }"
          :aria-hidden="true"
        ></span>
        <div class="snapshots-rail-content">
          <span class="snapshots-rail-label">
            <template v-if="restoreInFlight">{{ t('snapshots.restoringStatus', 'Restoring snapshot') }}</template>
            <template v-else-if="restoreTerminal === 'ok'">{{ t('snapshots.restored', 'Snapshot restored') }}</template>
            <template v-else-if="restoreTerminal === 'error'">{{ t('snapshots.restoreFailed', 'Restore failed') }}</template>
            <template v-else>{{ t('snapshots.createLabel', 'Create Snapshot') }}</template>
          </span>
          <div
            class="snapshots-rail-save-box"
            :class="{
              'is-op-inflight':  restoreInFlight,
              'is-op-success':   restoreTerminal === 'ok',
              'is-op-error':     restoreTerminal === 'error'
            }"
          >
            <!-- In-flight: prominent card with target label, phase text,
                 percent bar, and (when supported) a Cancel action. -->
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

            <!-- Success: stays for ~1.8s before auto-dismissing. -->
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

            <!-- Idle: the original Save CTA returns when there is no op
                 in flight or terminal state pending dismissal. -->
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
              :previous-comfyui-version="snapshots[item.snapshotIndex + 1]?.comfyuiVersion"
              :toggle-test-id="TID.snapshotRow(item.snapshot.filename)"
              @toggle="toggleExpand(item.snapshot.filename)"
            >
              <template #expanded>
                <p v-if="item.snapshot.label" class="snapshots-view-label">
                  {{ item.snapshot.label }}
                </p>

                <!-- Diff accordion A — "release notes": what changed FROM the
                     previous snapshot TO this one. Lazy-loads the `previous`
                     diff on first open. Hidden for the oldest snapshot (no
                     predecessor to compare against). -->
                <div v-if="i < timeline.length - 1" class="snap-diff-accordion">
                  <button
                    type="button"
                    class="snap-diff-trigger"
                    :class="{ 'is-open': isDiffOpen(item.snapshot.filename, 'previous') }"
                    :aria-expanded="isDiffOpen(item.snapshot.filename, 'previous')"
                    @click="toggleDiff(item.snapshot.filename, 'previous')"
                  >
                    <ChevronDown :size="13" class="snap-diff-chevron" />
                    <span>{{ t('snapshots.changesInSnapshot', 'What changed in this snapshot') }}</span>
                  </button>
                  <BaseAccordion :open="isDiffOpen(item.snapshot.filename, 'previous')">
                    <div class="snapshots-view-diff">
                      <div
                        v-if="isDiffLoading(item.snapshot.filename, 'previous')"
                        class="snapshots-view-diff-loading"
                      >
                        {{ t('common.loading', 'Loading…') }}
                      </div>
                      <template v-else-if="diffFor(item.snapshot.filename, 'previous') !== undefined">
                        <div
                          v-if="!diffFor(item.snapshot.filename, 'previous') || !diffHasChanges(diffFor(item.snapshot.filename, 'previous')!.diff)"
                          class="snapshots-view-diff-empty"
                        >
                          {{ t('snapshots.diffNoChanges', 'No changes from the previous snapshot.') }}
                        </div>
                        <SnapshotDiffView
                          v-else
                          :diff="diffFor(item.snapshot.filename, 'previous')!.diff"
                        />
                      </template>
                    </div>
                  </BaseAccordion>
                </div>

                <!-- Diff accordion B — "restore preview": what would change if
                     you restore THIS snapshot from the live install state.
                     Lazy-loads the `current` diff. Hidden for the current
                     (newest) snapshot — restoring it is a no-op. -->
                <div v-if="i !== 0" class="snap-diff-accordion">
                  <button
                    type="button"
                    class="snap-diff-trigger"
                    :class="{ 'is-open': isDiffOpen(item.snapshot.filename, 'current') }"
                    :aria-expanded="isDiffOpen(item.snapshot.filename, 'current')"
                    @click="toggleDiff(item.snapshot.filename, 'current')"
                  >
                    <ChevronDown :size="13" class="snap-diff-chevron" />
                    <span>{{ t('snapshots.ifYouRestore', 'What restoring this would change') }}</span>
                  </button>
                  <BaseAccordion :open="isDiffOpen(item.snapshot.filename, 'current')">
                    <div class="snapshots-view-diff">
                      <div
                        v-if="isDiffLoading(item.snapshot.filename, 'current')"
                        class="snapshots-view-diff-loading"
                      >
                        {{ t('common.loading', 'Loading…') }}
                      </div>
                      <template v-else-if="diffFor(item.snapshot.filename, 'current') !== undefined">
                        <div
                          v-if="!diffFor(item.snapshot.filename, 'current') || !diffHasChanges(diffFor(item.snapshot.filename, 'current')!.diff)"
                          class="snapshots-view-diff-empty"
                        >
                          {{ t('snapshots.restoreNoChanges', 'Restoring this would make no changes — it matches your current state.') }}
                        </div>
                        <SnapshotDiffView
                          v-else
                          :diff="diffFor(item.snapshot.filename, 'current')!.diff"
                        />
                      </template>
                    </div>
                  </BaseAccordion>
                </div>

                <!-- Actions live in the expanded detail (per Figma): the
                     collapsed row stays a clean tap target, and the
                     destructive / mutating ops only surface once the
                     user has expressed intent by expanding the row. -->
                <div class="snapshots-view-detail-actions">
                  <button
                    v-if="i !== 0"
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

/* Restore in-flight — rotating conic ring on the dot. Matches the
 * picker row's `op-dot-spin` treatment so the same visual vocabulary
 * means "this thing is being worked on" across the app. */
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
  to { transform: rotate(360deg); }
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
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
}

/* Diff accordions (release-notes + restore-preview). Trigger is a flat
 * text+chevron row; the panel reuses `.snapshots-view-diff` chrome. */
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

/* Top-card restore feedback. Lives in the dashed "Save New Snapshot"
 * slot at the top of the timeline so the user sees the operation at
 * the top of their attention rather than buried mid-list. Three
 * outcomes: in-flight (default border, percent bar), success (green
 * tint, auto-dismiss), error (red tint, retry/dismiss actions). */
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
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

.snapshots-op-card-error-msg {
  margin: 0;
  font-size: var(--takeover-fs-caption);
  color: var(--danger, #ef4444);
  /* Preserve the action's `headline\n\n<detail lines>` so a failed restore
   * shows WHY it failed (which node / package / git error), not just a
   * one-liner. Cap height + scroll so a long failure list doesn't push the
   * Retry / Dismiss actions off-screen. */
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
