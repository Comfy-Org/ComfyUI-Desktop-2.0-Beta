<script setup lang="ts">
import { computed, onMounted, ref, toRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LayoutDashboard, Plus, Search, X } from 'lucide-vue-next'
import BaseInput from '../components/ui/BaseInput.vue'
import { FILTER_CHIPS, useInstallList } from '../composables/useInstallList'
import { useCloudCapacity } from '../composables/useCloudCapacity'
import { useDialogs } from '../composables/useDialogs'
import { useSessionStore } from '../stores/sessionStore'
import ComfyUISettingsContent from '../components/settings/ComfyUISettingsContent.vue'
import InfoTooltip from '../components/InfoTooltip.vue'
import Tooltip from '../components/ui/Tooltip.vue'
import InstanceRow from './instancePicker/InstanceRow.vue'
import { resolvePickerTab, type PickerTab } from '../lib/pickerTabs'
import { resolveProgressRouting } from '../lib/pickerProgressRouting'
import { mergePanelLocaleIntoPopup } from './pickerSettingsApiShim'
import type {
  DetailSection,
  Installation,
  RunningInstance,
  ShowProgressOpts,
  SnapshotListData
} from '../types/ipc'

interface PickerInstall {
  id: string
  name: string
  sourceLabel: string
  sourceCategory: string
  version?: string
  lastLaunchedAt?: number
  installPath?: string
  status?: string
  statusTag?: { style: string; label: string }
}

interface PickerStorageDir {
  path: string
  isPrimary: boolean
}

/** Must stay in sync with `PickerStorageSlice` in `src/main/popups/titlePopup.ts`. */
interface PickerStorageSlice {
  sharedDirectoriesFields: Record<string, unknown>[]
  modelsDirs: PickerStorageDir[]
  modelsSystemDefault: string
}

interface PickerOperationStatus {
  percent: number
  status: string
  speedBytesPerSec?: number | null
  done: boolean
  ok: boolean | null
  error: string | null
  cancellable: boolean
  title: string
  actionId: string
  actionData?: Record<string, unknown>
}

interface PickerSnapshot {
  installs: PickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
  /** Installs launching but not yet started. Hydrated into
   *  sessionStore because the popup preload has no onInstanceLaunching. */
  launchingInstallationIds: string[]
  selectedInstallationId: string | null
  /** Bumped only when main intentionally retargets the selection. The view
   *  applies selectedInstallationId over a local pick only when this advances,
   *  so a stale rebroadcast can't snap the user back to a prior row. */
  pickerSelectionEpoch?: number
  selectedSettings: DetailSection[] | null
  selectedSnapshots: SnapshotListData | null
  initialTab?: string | null
  autoAction?: string | null
  autoActionNonce?: number
  storage: PickerStorageSlice
  operatingInstallationIds?: string[]
  installOperationStatus?: Record<string, PickerOperationStatus>
}

const props = defineProps<{
  snapshot: PickerSnapshot
}>()

const { mergeLocaleMessage } = useI18n()

const sessionStore = useSessionStore()
function hydrateSessionStoreFromSnapshot(): void {
  const next = new Set(props.snapshot.runningInstallationIds)
  for (const id of Array.from(sessionStore.runningInstances.keys())) {
    if (!next.has(id)) sessionStore.runningInstances.delete(id)
  }
  for (const id of next) {
    if (!sessionStore.runningInstances.has(id)) {
      const placeholder: RunningInstance = {
        installationId: id,
        installationName: '',
        mode: ''
      }
      sessionStore.runningInstances.set(id, placeholder)
    }
  }
  // The snapshot is the only path that brings launching state in (the
  // popup preload has no onInstanceLaunching).
  const nextLaunching = new Set(props.snapshot.launchingInstallationIds ?? [])
  for (const id of Array.from(sessionStore.launchingInstances.keys())) {
    if (!nextLaunching.has(id)) sessionStore.launchingInstances.delete(id)
  }
  for (const id of nextLaunching) {
    if (!sessionStore.launchingInstances.has(id)) {
      sessionStore.launchingInstances.set(id, { installationName: '' })
    }
  }
}

let panelLocaleMerge: Promise<void> | null = null
function ensurePanelLocaleMerged(): Promise<void> {
  panelLocaleMerge ??= mergePanelLocaleIntoPopup(mergeLocaleMessage)
  return panelLocaleMerge
}

interface PickerBridge {
  platform?: string
  activate?: (id: string) => void
  close?: () => void
  pickInstall: (installationId: string) => void
  openNewInstall: () => void
  restartInstall: (installationId: string, opts?: { confirmed?: boolean }) => void
  setPickerSelectedInstall: (installationId: string | null) => void
  pickerUpdateField: (
    installationId: string,
    fieldId: string,
    value: unknown
  ) => Promise<{ ok: boolean; message?: string }>
  pickerRunAction: (
    installationId: string,
    actionId: 'snapshot-save' | 'snapshot-restore' | 'snapshot-delete',
    actionData?: Record<string, unknown>
  ) => Promise<{ ok: boolean; message?: string }>
  openInstallAction: (installationId: string, actionId: string) => void
  pickerForwardShowProgress: (payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable?: boolean
    triggersInstanceStart?: boolean
    opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
    isRestart?: boolean
    routing?: 'same-host' | 'target-host' | 'inline-picker'
    successChoice?: boolean
  }) => void
  pickerStartBackgroundOp: (payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable?: boolean
    opKind?: string
  }) => void
  pickerCancelBackgroundOp: (installationId: string) => void
  pickerDismissBackgroundOp: (installationId: string) => void
}
const bridge = (window as unknown as { __comfyTitlePopup?: PickerBridge }).__comfyTitlePopup

const installations = computed<Installation[]>(
  () => props.snapshot.installs as unknown as Installation[]
)
const installationsRef = toRef(() => installations.value)
const {
  searchQuery,
  activeFilter,
  cloudInstall,
  visibleInstalls,
  showCloudCard,
  showEmptyHint,
  lastLaunchedShortLabel
} = useInstallList({ installations: installationsRef })

/** Folds cloud into the recency-sorted list (sorted by its own
 *  lastLaunchedAt). On a recency tie cloud is ordered first, but the
 *  auto-selected default still favours a real install (see
 *  `resolvePickerSelectedInstallId` in main). */
const pickerRows = computed<Installation[]>(() => {
  const rows = [...visibleInstalls.value]
  if (showCloudCard.value && cloudInstall.value) {
    rows.push(cloudInstall.value)
  }
  return rows.sort((a, b) => {
    const ta = a.lastLaunchedAt ?? -Infinity
    const tb = b.lastLaunchedAt ?? -Infinity
    if (tb !== ta) return tb - ta
    return (b.sourceCategory === 'cloud' ? 1 : 0) - (a.sourceCategory === 'cloud' ? 1 : 0)
  })
})

const visibleChips = computed(() => {
  return FILTER_CHIPS.filter((chip) => {
    if (chip.key === 'all') return true
    const count = installations.value.filter((i) => {
      if (chip.key === 'local') {
        return i.sourceCategory === 'local'
      }
      return i.sourceCategory === chip.key
    }).length
    return count > 0
  })
})

/** Default selection when the popup opens with no active/selected install.
 *  Tie-break mirrors main's `mostRecentlyLaunchedInstallId`: on a tie a real
 *  install wins so the always-seeded Cloud entry can't claim the default. */
function mostRecentInstallId(installs: PickerInstall[]): string | null {
  let best: PickerInstall | undefined
  for (const inst of installs) {
    if (!best) {
      best = inst
      continue
    }
    const ts = inst.lastLaunchedAt ?? 0
    const bestTs = best.lastLaunchedAt ?? 0
    if (ts > bestTs) {
      best = inst
    } else if (ts === bestTs && best.sourceCategory === 'cloud' && inst.sourceCategory !== 'cloud') {
      best = inst
    }
  }
  return best?.id ?? null
}

function resolveInitialSelection(snapshot: PickerSnapshot): string | null {
  const explicit = snapshot.selectedInstallationId ?? snapshot.activeInstallationId
  if (explicit) return explicit
  return mostRecentInstallId(snapshot.installs)
}
const selectedId = ref<string | null>(resolveInitialSelection(props.snapshot))
// Largest pickerSelectionEpoch applied so far; only a strictly-greater
// snapshot epoch counts as a main-authoritative retarget.
const appliedSelectionEpoch = ref<number>(props.snapshot.pickerSelectionEpoch ?? 0)

watch(
  () => props.snapshot.pickerSelectionEpoch ?? 0,
  (nextEpoch) => {
    if (nextEpoch <= appliedSelectionEpoch.value) return
    // Main intentionally retargeted; a fresh open overrides any local pick.
    appliedSelectionEpoch.value = nextEpoch
    selectedId.value = resolveInitialSelection(props.snapshot)
  }
)

// Cold-start fallback: seed selectedId once installs land if the snapshot
// first arrived empty. Once a selection exists, live install-list updates
// must not touch it (would reintroduce the snap-back).
watch(
  () => props.snapshot.installs,
  (installs) => {
    if (selectedId.value) return
    const id = mostRecentInstallId(installs)
    if (id) {
      selectedId.value = id
    }
  }
)

const selectedInstall = computed<Installation | null>(() => {
  const id = selectedId.value
  if (id) {
    const found = installations.value.find((i) => i.id === id)
    if (found) return found
  }
  return null
})

const runningSet = computed(() => new Set(props.snapshot.runningInstallationIds))
// Optimistic local state set on click so the progress view appears before
// the IPC round-trip + snapshot lands; cleared once the snapshot confirms.
const localOperationStatus = ref<Map<string, PickerOperationStatus>>(new Map())

watch(
  () => props.snapshot.installOperationStatus,
  (snapshotOps) => {
    for (const id of localOperationStatus.value.keys()) {
      if (snapshotOps?.[id]) {
        localOperationStatus.value.delete(id)
      }
    }
  },
  { deep: true }
)

const activeOperation = computed<PickerOperationStatus | null>(() => {
  const id = selectedId.value
  if (!id) return null
  return props.snapshot.installOperationStatus?.[id] ?? localOperationStatus.value.get(id) ?? null
})

const effectiveOperatingSet = computed(() => {
  const s = new Set(props.snapshot.operatingInstallationIds ?? [])
  for (const id of localOperationStatus.value.keys()) s.add(id)
  return s
})

function isRowRunning(inst: Installation): boolean {
  return runningSet.value.has(inst.id)
}

function isRowCurrent(inst: Installation): boolean {
  return !!props.snapshot.activeInstallationId && inst.id === props.snapshot.activeInstallationId
}

/** Must mirror the `showUpdateBadge` check in `ComfyUISettingsContent.vue`. */
function isRowUpdateAvailable(inst: Installation): boolean {
  const tagged = inst as Installation & { statusTag?: { style?: string }; status?: string }
  return tagged.statusTag?.style === 'update' || tagged.status === 'update-available'
}

function handleSelect(inst: Installation): void {
  selectedId.value = inst.id
}

function handleNewInstall(): void {
  bridge?.openNewInstall()
}

function handleClose(): void {
  bridge?.close?.()
}

const isInstallHost = computed(() => !!props.snapshot.activeInstallationId)

/** Routes through `new-window` rather than `return-to-dashboard`: the latter
 *  detaches the install, which stops the running instance. */
function handleOpenDashboard(): void {
  bridge?.activate?.('new-window')
}

watch(
  () => selectedInstall.value?.id ?? null,
  (next) => {
    bridge?.setPickerSelectedInstall(next)
  }
)

// On an install-less host the initial fallback selection never reaches main
// via the change-only watcher above, so persist it once on mount.
if (
  selectedId.value &&
  !props.snapshot.selectedInstallationId &&
  !props.snapshot.activeInstallationId
) {
  bridge?.setPickerSelectedInstall(selectedId.value)
}

const initialExpandedTab = computed<PickerTab>(() =>
  resolvePickerTab(props.snapshot.initialTab, 'update')
)

// Both lifecycle id arrays must be watched: the snapshot is the sole source
// of truth for sessionStore, and watching only runningInstallationIds would
// miss launching-only transitions. NUL-joined to avoid comma collisions.
watch(
  [
    () => props.snapshot.runningInstallationIds.join('\0'),
    () => (props.snapshot.launchingInstallationIds ?? []).join('\0')
  ],
  () => hydrateSessionStoreFromSnapshot(),
  { immediate: true }
)

onMounted(() => {
  void ensurePanelLocaleMerged()
})

function handleSettingsShowProgress(opts: ShowProgressOpts): void {
  if (!opts.actionId) return
  // opts.actionData may be a Vue reactive proxy, which can't cross the
  // contextBridge structured-clone boundary; deep-clone to a plain object.
  const rawActionData = opts.actionData
    ? JSON.parse(JSON.stringify(opts.actionData)) as Record<string, unknown>
    : undefined
  const { routing, successChoice } = resolveProgressRouting(
    opts,
    props.snapshot.activeInstallationId
  )
  if (routing === 'inline-picker') {
    // Seed optimistic local state so the progress view appears before the
    // IPC round-trip lands. Seed main's first-tick status for snapshot
    // restore so the line doesn't flash the "Working…" fallback.
    localOperationStatus.value.set(opts.installationId, {
      percent: -1,
      status: opts.actionId === 'snapshot-restore' ? 'Loading snapshot…' : '',
      done: false,
      ok: null,
      error: null,
      cancellable: opts.cancellable ?? false,
      title: opts.title,
      actionId: opts.actionId,
      actionData: rawActionData,
    })
    selectedId.value = opts.installationId
    bridge?.pickerStartBackgroundOp({
      installationId: opts.installationId,
      actionId: opts.actionId,
      actionData: rawActionData,
      title: opts.title,
      cancellable: opts.cancellable,
      opKind: opts.opKind,
    })
    return
  }
  bridge?.pickerForwardShowProgress({
    installationId: opts.installationId,
    actionId: opts.actionId,
    actionData: rawActionData,
    title: opts.title,
    cancellable: opts.cancellable,
    triggersInstanceStart: opts.triggersInstanceStart,
    opKind: opts.opKind,
    isRestart: opts.actionId === 'restart',
    routing,
    successChoice
  })
}

function handleInlineProgressCancel(): void {
  const id = selectedId.value
  if (!id) return
  bridge?.pickerCancelBackgroundOp(id)
}

function handleInlineProgressRetry(): void {
  const id = selectedId.value
  if (!id || !activeOperation.value) return
  const op = activeOperation.value
  bridge?.pickerStartBackgroundOp({
    installationId: id,
    actionId: op.actionId,
    actionData: op.actionData,
    title: op.title,
    cancellable: op.cancellable,
  })
}

function handleInlineProgressDismiss(): void {
  const id = selectedId.value
  if (!id) return
  bridge?.pickerDismissBackgroundOp(id)
}

function handleSettingsNavigateList(): void {
  selectedId.value = null
}

// Capacity-protection switch (PostHog flag `desktop-cloud-capacity`):
// when disabled, the primary action no-ops for a cloud install.
const cloudCapacity = useCloudCapacity()
const dialogs = useDialogs()
const ippCapacityStatus = computed(() => cloudCapacity.effectiveStatus())

async function handleExpandedPrimaryAction(restartInPlace: boolean): Promise<void> {
  const inst = selectedInstall.value
  if (!inst) return
  // Cloud capacity gate; matches the ChooserView path so the two can't diverge.
  if (inst.sourceCategory === 'cloud' && !(await cloudCapacity.confirmEntry())) return
  if (restartInPlace) {
    // Confirm in-drawer for local restarts (cloud/remote have no local
    // process to kill); keeps the drawer open instead of reopening as a
    // system-modal over the host.
    if (inst.sourceCategory === 'local') {
      const result = await dialogs.confirm({
        title: 'Restart instance?',
        message: 'Restart this instance?',
        confirmLabel: 'Restart',
        cancelLabel: 'Cancel',
        messageDetails: [
          {
            label: 'Heads up',
            items: [
              'Restarting will stop the running session.',
              'Any unsaved work in the workflow will be lost.',
            ],
          },
        ],
      })
      if (result !== 'primary') return
    }
    // `confirmed: true` tells main to skip its own system-modal since the
    // renderer already prompted.
    bridge?.restartInstall(inst.id, { confirmed: true })
  } else {
    bridge?.pickInstall(inst.id)
  }
}
</script>

<template>
  <div class="picker">
    <div class="picker-search">
      <BaseInput
        v-model="searchQuery"
        class="picker-search-input"
        :placeholder="$t('chooser.searchPlaceholder')"
        :aria-label="$t('chooser.searchPlaceholder')"
      >
        <template #leading><Search :size="20" class="picker-search-icon" /></template>
      </BaseInput>
      <button
        type="button"
        class="picker-close"
        :aria-label="$t('common.close')"
        :title="$t('common.close')"
        @click="handleClose"
      >
        <X :size="18" />
      </button>
    </div>

    <div class="picker-chips-row">
      <template v-if="isInstallHost">
        <Tooltip :text="$t('instancePicker.openDashboardHint')" side="bottom">
          <button
            type="button"
            class="picker-home"
            :aria-label="$t('instancePicker.openDashboard')"
            @click="handleOpenDashboard"
          >
            <LayoutDashboard :size="14" />
            <span class="picker-home-label">{{ $t('instancePicker.openDashboard') }}</span>
          </button>
        </Tooltip>
        <span class="picker-chips-divider" aria-hidden="true"></span>
      </template>
      <div
        class="picker-chips"
        role="tablist"
        :aria-label="$t('chooser.filterLabel', 'Source filter')"
      >
        <button
          v-for="chip in visibleChips"
          :key="chip.key"
          type="button"
          role="tab"
          class="picker-chip"
          :class="{ 'is-active': activeFilter === chip.key }"
          :aria-selected="activeFilter === chip.key"
          @click="activeFilter = chip.key"
        >
          {{ $t(chip.labelKey) }}
        </button>
      </div>
    </div>

    <div class="picker-body">
      <div class="picker-left">
        <div class="picker-list-section">
          <div class="picker-list-section-title">{{ $t('instancePicker.instances') }}<InfoTooltip :text="$t('tooltips.instances')" side="bottom" /></div>

          <div class="picker-list" role="listbox">
            <InstanceRow
              v-for="inst in pickerRows"
              :key="inst.id"
              :installation="inst"
              :active="selectedId === inst.id"
              :running="isRowRunning(inst)"
              :is-current="isRowCurrent(inst)"
              :update-available="isRowUpdateAvailable(inst)"
              :operating="effectiveOperatingSet.has(inst.id)"
              :last-launched-short-label="lastLaunchedShortLabel(inst)"
              :capacity-status="ippCapacityStatus"
              @select="handleSelect"
            />

            <div v-if="showEmptyHint" class="picker-list-empty">
              {{ $t('chooser.noMatches') }}
            </div>
          </div>
        </div>

        <footer class="picker-left-footer">
          <button type="button" class="picker-new-install" @click="handleNewInstall">
            <Plus :size="16" />
            <span>{{ $t('instancePicker.newInstance') }}</span>
          </button>
        </footer>
      </div>

      <div class="picker-detail-wrap is-expanded">
        <div class="picker-detail">
          <template v-if="selectedInstall">
            <ComfyUISettingsContent
              :installation="selectedInstall"
              :initial-tab="initialExpandedTab"
              :auto-action="snapshot.autoAction ?? null"
              :auto-action-nonce="snapshot.autoActionNonce ?? 0"
              :global-settings-snapshot="snapshot.storage"
              :active-operation="activeOperation"
              :active-installation-id="snapshot.activeInstallationId"
              class="picker-expanded-body"
              @show-progress="handleSettingsShowProgress"
              @navigate-list="handleSettingsNavigateList"
              @request-close="handleSettingsNavigateList"
              @request-dismiss="handleClose"
              @primary-action="handleExpandedPrimaryAction"
              @op-cancel="handleInlineProgressCancel"
              @op-retry="handleInlineProgressRetry"
              @op-dismiss="handleInlineProgressDismiss"
            />
          </template>
          <div v-else class="picker-detail-empty">
            {{ $t('instancePicker.empty') }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  background: var(--modal-surface-bg);
}

.picker-search {
  display: flex;
  align-items: center;
  gap: 4px;
  border-bottom: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  padding: 6px 8px 8px 12px;
}
.picker-search-input {
  flex: 1 1 auto;
  min-width: 0;
}
.picker-search :deep(.ui-input) {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  gap: 8px;
}
.picker-close {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color 100ms ease,
    color 100ms ease,
    border-color 100ms ease;
}
.picker-close:hover,
.picker-close:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--neutral-100);
  outline: none;
}
.picker-search :deep(.ui-input):focus-within {
  border-color: transparent;
}
.picker-search :deep(.ui-input-leading) {
  color: var(--text);
}
.picker-search :deep(.ui-input-control) {
  padding: 2px 0 0 0;
  font-size: 14px;
  line-height: 20px;
  color: var(--text);
}
.picker-search :deep(.ui-input-control::placeholder) {
  color: var(--text);
  opacity: 0.6;
}

.picker-search-icon {
  color: var(--accent-label);
  margin-top: 2px;
}
.picker-chips-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px 10px 16px;
  border-bottom: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
}
.picker-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.picker-home {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 22px;
  padding: 0 6px 0 2px;
  border: none;
  background: transparent;
  color: var(--neutral-100);
  cursor: pointer;
  transition: color 100ms ease;
}
.picker-home-label {
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
}
.picker-home:hover,
.picker-home:focus-visible {
  color: var(--text);
  outline: none;
}
.picker-chips-divider {
  flex: 0 0 auto;
  display: inline-block;
  width: 1px;
  height: 16px;
  background: var(--brand-surface-border-hover, var(--chooser-surface-border));
}
.picker-chip {
  height: 22px;
  padding: 2px 10px;
  border-radius: 9999px;
  border: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  color: var(--neutral-100);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition:
    background-color 100ms ease,
    border-color 100ms ease,
    color 100ms ease;
}
.picker-chip:hover,
.picker-chip:focus-visible {
  outline: none;
  color: var(--text);
}
.picker-chip.is-active {
  background: var(--chooser-surface-border);
  border-color: var(--brand-surface-border-hover);
  color: var(--text);
}

.picker-body {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
}

.picker-left {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--chooser-surface-border);
  background: var(--modal-surface-bg);
}
.picker-left-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--chooser-surface-border);
  background: var(--modal-surface-bg);
}
.picker-list-section {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.picker-list-section-title {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--neutral-100);
  opacity: 0.7;
  padding: 12px 18px 0 16px;
  margin-bottom: 14px;
}
.picker-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.picker-list-empty {
  padding: 8px 18px;
  font-size: 14px;
  color: var(--neutral-100);
}

.picker-new-install {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 32px;
  padding: 8px 14px;
  border-radius: 8px;
  width: fit-content;
  border: none;
  background: var(--chooser-surface-border-hover);
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}
.picker-new-install:hover,
.picker-new-install:focus-visible {
  background: var(--brand-surface-border-hover);
  color: var(--text);
  outline: none;
}

.picker-detail-wrap {
  min-width: 0;
  min-height: 0;
  padding: 0 8px;
  display: flex;
  overflow: hidden;
}
.picker-detail {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.picker-detail-empty {
  margin: auto;
  font-size: 14px;
  color: var(--neutral-100);
  opacity: 0.7;
}

.picker-detail-wrap.is-expanded {
  padding: 0;
}
.picker-detail-wrap.is-expanded .picker-detail {
  gap: 0;
}

.picker-expanded-body {
  flex: 1 1 auto;
  min-height: 0;
  --text-muted: var(--neutral-100);
}
</style>
