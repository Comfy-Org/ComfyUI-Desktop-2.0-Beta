<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import { useTitlePopupAutoResize } from '../composables/useTitlePopupAutoResize'
import { useI18n } from 'vue-i18n'
import { Plus, Search } from 'lucide-vue-next'
import BaseInput from '../components/ui/BaseInput.vue'
import { FILTER_CHIPS, useInstallList } from '../composables/useInstallList'
import { useSessionStore } from '../stores/sessionStore'
import ComfyUISettingsContent from '../components/settings/ComfyUISettingsContent.vue'
import InstanceRow from './instancePicker/InstanceRow.vue'
import PickerRow from './instancePicker/PickerRow.vue'
import { resolvePickerTab, type PickerTab } from '../lib/pickerTabs'
import { mergePanelLocaleIntoPopup } from './pickerSettingsApiShim'
import { useModal } from '../composables/useModal'
import type {
  DetailSection,
  Installation,
  RunningInstance,
  ShowProgressOpts,
  SnapshotListData,
} from '../types/ipc'

/**
 * Instance-picker popover view.
 *
 * Renders the title-bar centre pill's dropdown. The popup webContents
 * shell (`TitlePopupApp.vue`) hands us a static snapshot per open;
 * subsequent install-registry changes arrive via the
 * `onInstancePickerSnapshot` bridge subscription so the list stays
 * fresh while the popover is open.
 *
 * Pure-prop component — no IPC handshake here, just `__comfyTitlePopup`
 * bridge calls on user actions. The popup shell owns the `set-config` →
 * `notifyRendered` handshake and the natural-height `requestSize` push.
 *
 * Search / filter / recency / cloud-split logic comes from the shared
 * `useInstallList` composable, so the picker and `ChooserView` cannot
 * diverge.
 */

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

interface PickerSnapshot {
  installs: PickerInstall[]
  activeInstallationId: string | null
  runningInstallationIds: string[]
  /** Per-row Settings + Snapshots payload — main pushes the data for
   *  whichever install the picker currently has selected. See
   *  `setPickerSelectedInstall` bridge call below for the sync. */
  selectedInstallationId: string | null
  selectedSettings: DetailSection[] | null
  selectedSnapshots: SnapshotListData | null
  /** Compact = identity-card right pane; expanded = full per-install
   *  settings UI in the right pane and the popup bounds grow to
   *  95dvw × 95dvh. Flipped via the `setPickerMode` bridge. */
  mode?: 'compact' | 'expanded'
  /** When `mode === 'expanded'`, the tab the settings UI opens on. */
  initialTab?: string | null
  /** When `mode === 'expanded'`, an action id to fire automatically. */
  autoAction?: string | null
}

const props = defineProps<{
  snapshot: PickerSnapshot
}>()

const { t, mergeLocaleMessage } = useI18n()

// Per-install settings UI depends on session-running state for the
// synthetic Launch→Restart swap. The popup doesn't subscribe to the
// session-lifecycle IPC fan-out (no `init()`); instead we hydrate the
// store's `runningInstances` map directly from the picker snapshot's
// `runningInstallationIds`. Each snapshot refresh re-syncs.
const sessionStore = useSessionStore()
function hydrateSessionStoreFromSnapshot(): void {
  const next = new Set(props.snapshot.runningInstallationIds)
  // Drop ids that are no longer running.
  for (const id of Array.from(sessionStore.runningInstances.keys())) {
    if (!next.has(id)) sessionStore.runningInstances.delete(id)
  }
  // Add ids that are newly running. We don't carry the full
  // `RunningInstance` payload through the snapshot (the picker only
  // surfaces ids), so seed with a minimal record — `useComfyUISettings`
  // only reads `.has(id)` via `isRunning(id)`.
  for (const id of next) {
    if (!sessionStore.runningInstances.has(id)) {
      const placeholder: RunningInstance = {
        installationId: id,
        installationName: '',
        mode: '',
      }
      sessionStore.runningInstances.set(id, placeholder)
    }
  }
}

// Merge main's locale catalog on first expand; compact path stays IPC-free.
let panelLocaleMerge: Promise<void> | null = null
function ensurePanelLocaleMerged(): Promise<void> {
  panelLocaleMerge ??= mergePanelLocaleIntoPopup(mergeLocaleMessage)
  return panelLocaleMerge
}

// Bridge surface — only the methods the picker dispatches on user
// actions. `onInstancePickerSnapshot` subscription is owned by the
// shell (TitlePopupApp.vue), so we don't subscribe here too — that
// would race with the shell's incoming-snapshot handling.
interface PickerBridge {
  platform?: string
  pickInstall: (installationId: string) => void
  openNewInstall: () => void
  restartInstall: (installationId: string) => void
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
  /** Picker → run an install-level action via the parent panel's
   *  `useInstallContextMenu` dispatch (Open Folder / Copy / Untrack /
   *  Delete). Main hides the popup, then forwards to the parent
   *  panel; the panel resolves to the same code path the dashboard
   *  kebab uses, so confirm dialogs + showProgress wiring are shared. */
  openInstallAction: (installationId: string, actionId: string) => void
  /** Ask main to resize the popup view to the given natural height.
   *  Same plumbing as `GlobalSettingsView` — main clamps to the picker's
   *  ceiling band so unbounded growth is impossible. */
  requestSize: (height: number) => void
  /** Picker → flip between compact and expanded modes. Main animates
   *  the popup bounds (compact → 95dvw × 95dvh centred). */
  setPickerMode: (
    mode: 'compact' | 'expanded',
    opts?: { initialTab?: string; autoAction?: string | null },
  ) => void
  /** Picker → forward a `show-progress` request to the panel renderer. */
  pickerForwardShowProgress: (payload: {
    installationId: string
    actionId: string
    actionData?: Record<string, unknown>
    title: string
    cancellable?: boolean
    triggersInstanceStart?: boolean
    opKind?: 'launch' | 'install' | 'update' | 'destructive' | 'snapshot' | 'generic'
    isRestart?: boolean
  }) => void
}
const bridge = (window as unknown as { __comfyTitlePopup?: PickerBridge }).__comfyTitlePopup

// --- shared list logic ---
//
// `useInstallList` takes a reactive installs ref; we re-coerce the
// snapshot prop into the renderer-side `Installation` shape (a
// superset of `PickerInstall` — every field the picker uses already
// exists in `Installation`).
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
  lastLaunchedLabel
} = useInstallList({ installations: installationsRef })

// Chips come from the shared `FILTER_CHIPS` constant in
// `useInstallList`, so ChooserView (when its hidden chip row comes
// back) and the picker can't drift in chip order or labels.
//
// Hide chips with zero installs in that bucket (except "All", which
// always shows) so the chip row stays useful instead of decorative.
const visibleChips = computed(() => {
  return FILTER_CHIPS.filter((chip) => {
    if (chip.key === 'all') return true
    const count = installations.value.filter((i) => {
      if (chip.key === 'local') {
        return i.sourceCategory === 'local' || i.sourceCategory === 'desktop'
      }
      return i.sourceCategory === chip.key
    }).length
    return count > 0
  })
})


// --- selection state ---
//
// Pre-select the install the snapshot points at. `selectedInstallationId`
// wins over `activeInstallationId` because it carries the explicit
// caller intent (chooser-card kebab "Restore Snapshot" / "Update" sends
// it), while `activeInstallationId` is just the host's currently-focused
// install. Falling back to `activeInstallationId` covers the title-bar
// pill click path where no specific install was requested.
function resolveInitialSelection(snapshot: PickerSnapshot): string | null {
  return snapshot.selectedInstallationId ?? snapshot.activeInstallationId
}
const selectedId = ref<string | null>(resolveInitialSelection(props.snapshot))
watch(
  () => props.snapshot.selectedInstallationId,
  (next) => {
    if (next) selectedId.value = next
  },
)
watch(
  () => props.snapshot.activeInstallationId,
  (next) => {
    if (!props.snapshot.selectedInstallationId) {
      selectedId.value = next
    }
  },
)

// Fall back to the first visible install when the active one isn't in
// the visible list (e.g. the user typed a query that filtered the
// active row out). Empty visible list → empty detail pane.
const selectedInstall = computed<Installation | null>(() => {
  const id = selectedId.value
  if (id) {
    const found = installations.value.find((i) => i.id === id)
    if (found) return found
  }
  return null
})

const runningSet = computed(() => new Set(props.snapshot.runningInstallationIds))

function isRowRunning(inst: Installation): boolean {
  return runningSet.value.has(inst.id)
}

// --- action dispatch ---
//
// The picker is a switcher: clicking a row UPDATES the right detail
// pane only, it does NOT launch. The Open button (and only the Open
// button) fires the actual `pickInstall` IPC. This matches the
// switcher pattern in the Figma — the popup stays open while the user
// browses installs and previews their details, then dismisses once
// they commit to one via Open.
function handleSelect(inst: Installation): void {
  selectedId.value = inst.id
}

/** Primary CTA dispatch for a row. Branches on running state: a
 *  running install means "Open" wouldn't do anything visible (main
 *  refocuses the existing window) so the CTA reads "Restart" and
 *  dispatches the restart flow — main confirms with a native dialog,
 *  stops the session, then re-launches. Otherwise "Open" → pickInstall
 *  (focus-or-launch) and the popup dismisses. */
function handleRowOpen(inst: Installation): void {
  if (runningSet.value.has(inst.id)) {
    bridge?.restartInstall(inst.id)
  } else {
    bridge?.pickInstall(inst.id)
  }
}

/** Per-row Manage CTA. Seeds the picker's selection to this install
 *  before flipping into expanded mode so the expanded view's left
 *  list lands on the row the user clicked.
 *
 *  Locale merge is kicked off in parallel with the mode dispatch
 *  (NOT awaited) — the previous `await ensurePanelLocaleMerged()`
 *  blocked the bounds-tween dispatch behind a main-side IPC round-
 *  trip, which is exactly the "first flip feels janky" beat. The
 *  settings UI is hidden under the 160ms cross-fade anyway, and the
 *  `snapshotMode === 'expanded'` watcher below also calls
 *  `ensurePanelLocaleMerged()` (cached after first use), so the
 *  catalog still lands before any settings text needs to render. */
function handleRowManage(inst: Installation): void {
  selectedId.value = inst.id
  void ensurePanelLocaleMerged()
  bridge?.setPickerMode('expanded', { initialTab: 'config' })
}

function openCtaLabelFor(inst: Installation): string {
  return runningSet.value.has(inst.id)
    ? t('instancePicker.restart')
    : t('instancePicker.open')
}

function handleNewInstall(): void {
  bridge?.openNewInstall()
}

// --- Mode + resize plumbing ---
//
// Selection sync: when the user picks a DIFFERENT install row, tell
// main so it can update its selection bookkeeping (used by the
// install-action dispatch + by Step 4-5's expanded-mode data flow).
//
// No `immediate: true` here: main's click handler already seeded
// `pickerSelectedInstallationId` with the host's active install before
// showing the popup. Firing this watcher on mount would cause a
// no-op snapshot rebroadcast → mid-open-animation `setBounds` flicker.
watch(
  () => selectedInstall.value?.id ?? null,
  (next) => {
    bridge?.setPickerSelectedInstall(next)
  },
)

// Resize plumbing for the natural-height popup. The right-pane
// identity card + CTA stack is the dominant height driver now that
// the Settings / Snapshots accordions are gone, so observe the
// detail column directly.
const pickerRootRef = useTemplateRef<HTMLDivElement>('pickerRootRef')
const detailRef = useTemplateRef<HTMLDivElement>('detailRef')

/** Mode the popup is currently in, from the most recent snapshot. */
const snapshotMode = computed<'compact' | 'expanded'>(
  () => props.snapshot.mode ?? 'compact',
)

useTitlePopupAutoResize(
  detailRef,
  () => {
    const root = pickerRootRef.value
    if (!root) return NaN
    // +2 for the `.popup` 1px top + 1px bottom border.
    return root.offsetHeight + 2
  },
  bridge?.requestSize ? bridge.requestSize.bind(bridge) : undefined,
  // Expanded mode is sized main-side from host content bounds — the
  // renderer's offsetHeight is meaningless there (and main's
  // `requestSize` handler already early-returns in expanded mode). Gate
  // the observer so we don't even compute the height while the mode-flip
  // cross-fade is running.
  { enabled: () => snapshotMode.value !== 'expanded' },
)

/** Initial tab to seed `ComfyUISettingsContent` with on the expanded
 *  branch's first mount. */
const initialExpandedTab = computed<PickerTab>(() =>
  resolvePickerTab(props.snapshot.initialTab, 'config'),
)

function handleCollapseToCompact(): void {
  bridge?.setPickerMode('compact')
}

// Keep `sessionStore.runningInstances` in sync with the snapshot's
// `runningInstallationIds`. Fires `immediate` so the very first render
// of the expanded UI already has correct running state.
watch(
  () => props.snapshot.runningInstallationIds.join(','),
  () => hydrateSessionStoreFromSnapshot(),
  { immediate: true },
)

// If main opens the picker directly in expanded mode (chooser-card
// kebab Update / Migrate / Restore / Delete in Step 6), pre-merge the
// locale on the first snapshot that lands so the settings UI's keys
// resolve from frame one.
watch(
  () => snapshotMode.value,
  (next, prev) => {
    if (next === 'expanded' && prev !== 'expanded') {
      void ensurePanelLocaleMerged()
    }
  },
  { immediate: true },
)

// ESC: collapse to compact when expanded, otherwise let the popup's
// existing close-on-ESC behaviour close the popup. Capture-phase
// listener so we win against any nested handlers inside the settings
// UI — but defer to ModalDialog when a confirm/alert is open so ESC
// resolves the dialog instead of tearing down the surface that owns it.
const { state: pickerModalState } = useModal()
function handleEsc(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (pickerModalState.visible) return
  if (snapshotMode.value === 'expanded') {
    event.preventDefault()
    event.stopPropagation()
    handleCollapseToCompact()
  }
}
onMounted(() => {
  document.addEventListener('keydown', handleEsc, true)
})
onUnmounted(() => {
  document.removeEventListener('keydown', handleEsc, true)
})

// Popup has no `ProgressModal` of its own; forward the request to the
// parent panel which mounts one. Main hides the popup so the modal is
// unobstructed; the panel rebuilds `apiCall` from actionId/actionData
// and runs it through its existing `handleShowProgress` pipeline.
function handleSettingsShowProgress(opts: ShowProgressOpts): void {
  if (!opts.actionId) return
  bridge?.pickerForwardShowProgress({
    installationId: opts.installationId,
    actionId: opts.actionId,
    actionData: opts.actionData,
    title: opts.title,
    cancellable: opts.cancellable,
    triggersInstanceStart: opts.triggersInstanceStart,
    opKind: opts.opKind,
    isRestart: opts.actionId === 'restart',
  })
}
function handleSettingsNavigateList(): void {
  // The selected install was deleted/untracked — flip back to compact
  // and let the snapshot rebroadcast scrub the row from the list.
  handleCollapseToCompact()
}

/** Expanded view's footer Open/Restart button. Routes through the
 *  exact same bridge calls the compact `PickerRow` Open/Restart
 *  button uses (`handleRowOpen`) so both surfaces share one
 *  native-confirm flow. The `running` flag is passed up from
 *  `ComfyUISettingsContent` so we don't re-derive it. */
function handleExpandedPrimaryAction(running: boolean): void {
  const inst = selectedInstall.value
  if (!inst) return
  if (running) {
    bridge?.restartInstall(inst.id)
  } else {
    bridge?.pickInstall(inst.id)
  }
}
</script>

<template>
  <div ref="pickerRootRef" class="picker">
    <div class="picker-search">
      <BaseInput
        v-model="searchQuery"
        :placeholder="t('chooser.searchPlaceholder')"
        :aria-label="t('chooser.searchPlaceholder')"
      >
        <template #leading><Search :size="20" class="picker-search-icon" /></template>
      </BaseInput>
    </div>

    <div class="picker-chips" role="tablist" aria-label="Source filter">
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
        {{ t(chip.labelKey) }}
      </button>
    </div>

    <!-- Mode flip cross-fade. `mode="out-in"` ensures the old subtree
         is gone before the new one mounts so the ResizeObserver doesn't
         double-measure mid-transition. The 160ms fade lands a hair
         before the main-side 200ms bounds tween so contents settle
         before the shell does. -->
    <Transition name="picker-mode" mode="out-in">
    <!-- Compact mode: single-column list of rich PickerRow cards. No
         left/right split — each row is self-contained with its own
         Open + Manage. Comfy Cloud renders as the same PickerRow shape
         so the visual rhythm holds. The "+ New Instance" affordance is
         pinned in a sticky footer so it stays visible while the list
         scrolls. -->
    <div v-if="snapshotMode !== 'expanded'" key="compact" ref="detailRef" class="picker-rows-wrap">
      <TransitionGroup name="picker-row" tag="div" class="picker-rows" role="list">
        <PickerRow
          v-if="showCloudCard && cloudInstall"
          :key="cloudInstall.id"
          :installation="cloudInstall"
          :active="selectedId === cloudInstall.id"
          :running="isRowRunning(cloudInstall)"
          :last-launched-label="lastLaunchedLabel(cloudInstall)"
          :open-label="openCtaLabelFor(cloudInstall)"
          :manage-label="t('instancePicker.manage')"
          @open="handleRowOpen"
          @manage="handleRowManage"
        />

        <PickerRow
          v-for="inst in visibleInstalls"
          :key="inst.id"
          :installation="inst"
          :active="selectedId === inst.id"
          :running="isRowRunning(inst)"
          :last-launched-label="lastLaunchedLabel(inst)"
          :open-label="openCtaLabelFor(inst)"
          :manage-label="t('instancePicker.manage')"
          @open="handleRowOpen"
          @manage="handleRowManage"
        />

        <div v-if="showEmptyHint" key="empty" class="picker-rows-empty">
          {{ t('chooser.noMatches') }}
        </div>
      </TransitionGroup>

      <footer class="picker-rows-footer">
        <button type="button" class="picker-new-install-row" @click="handleNewInstall">
          <Plus :size="16" aria-hidden="true" />
          <span>{{ t('instancePicker.newInstance') }}</span>
        </button>
      </footer>
    </div>

    <!-- Expanded mode: list-left + settings-right. Unchanged from
         the previous design — the per-install settings UI mounts in
         the right pane and the popup bounds grow to fill inner area. -->
    <div v-else key="expanded" class="picker-body">
      <div class="picker-left">
        <div class="picker-list-section">
          <div class="picker-list-section-title">{{ t('instancePicker.instances') }}</div>

          <div class="picker-list" role="listbox">
            <InstanceRow
              v-if="showCloudCard && cloudInstall"
              :key="cloudInstall.id"
              :installation="cloudInstall"
              :active="selectedId === cloudInstall.id"
              :running="isRowRunning(cloudInstall)"
              :last-launched-label="lastLaunchedLabel(cloudInstall)"
              @select="handleSelect"
            />

            <InstanceRow
              v-for="inst in visibleInstalls"
              :key="inst.id"
              :installation="inst"
              :active="selectedId === inst.id"
              :running="isRowRunning(inst)"
              :last-launched-label="lastLaunchedLabel(inst)"
              @select="handleSelect"
            />

            <div v-if="showEmptyHint" class="picker-list-empty">
              {{ t('chooser.noMatches') }}
            </div>
          </div>
        </div>

        <footer class="picker-left-footer">
          <button type="button" class="picker-new-install" @click="handleNewInstall">
            <Plus :size="16" />
            <span>{{ t('instancePicker.newInstance') }}</span>
          </button>
        </footer>
      </div>

      <div class="picker-detail-wrap is-expanded">
        <div class="picker-detail">
          <template v-if="selectedInstall">
            <!-- Back affordance is rendered inside the settings tab
                 strip via `showBack` so it sits at the tab baseline
                 instead of floating over the tab nav. ESC still
                 collapses (see handleEsc above). -->
            <ComfyUISettingsContent
              :installation="selectedInstall"
              :initial-tab="initialExpandedTab"
              :show-back="true"
              class="picker-expanded-body"
              @show-progress="handleSettingsShowProgress"
              @navigate-list="handleSettingsNavigateList"
              @primary-action="handleExpandedPrimaryAction"
              @back="handleCollapseToCompact"
            />
          </template>
          <div v-else class="picker-detail-empty">
            {{ t('instancePicker.empty') }}
          </div>
        </div>
      </div>
    </div>
    </Transition>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
}

.picker-search {
  border-bottom: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
  padding: 6px 12px 8px 12px;
}
.picker-search :deep(.ui-input) {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  gap: 8px;
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
.picker-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 16px 10px 16px;
  border-bottom: 1px solid var(--brand-surface-border-hover, var(--chooser-surface-border));
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
  background: var(--neutral-800);
}
/* Footer band — mirrors the right pane's `.settings-v2-footer` shape
 * (full-bleed bordered band, same padding + bg) so the two footers
 * line up at the bottom of the expanded popup. */
.picker-left-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--chooser-surface-border);
  background: var(--neutral-800);
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
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--text);
  padding: 8px 18px 0 16px;
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
  /* Pairs visually with the right-footer "More" button — both sit in
   * the same expanded-mode footer band, so they share the same 10%
   * white overlay (lives in `--chooser-surface-border-hover` — see
   * note on `.settings-v2-more`) and the same muted-on-text-default
   * resting state. */
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

/* ---- Compact mode: single-column rows ----
 * Two-section flex column: scrollable rows list on top, sticky footer
 * with the "+ New Instance" affordance below. The outer envelope is
 * capped at 720px by `computePickerBounds`; rows fill that envelope
 * edge-to-edge (minus the wrap's 16px gutter) so they don't read as
 * undersized inside a too-wide popup. */
.picker-rows-wrap {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px 16px 0 16px;
  overflow: hidden;
}
.picker-rows {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Hide the native scrollbar — popup is a focused glance affordance,
   * a visible scrollbar would compete with the row chrome. */
  scrollbar-width: none;
}
.picker-rows::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
.picker-rows-empty {
  padding: 16px;
  font-size: 13px;
  color: var(--neutral-100);
  text-align: center;
}
.picker-rows-footer {
  flex: 0 0 auto;
  display: flex;
  padding: 12px 0 16px 0;
}
.picker-new-install-row {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 36px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px dashed var(--brand-surface-border-hover, var(--chooser-surface-border));
  background: transparent;
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
.picker-new-install-row:hover,
.picker-new-install-row:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--text);
  outline: none;
}

/* ---- Expanded mode: list-left + settings-right ---- */
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

/* ---- Expanded Manage state ---- */
/* When the popup is in expanded mode (main has animated bounds to
 * ~95dvw × 95dvh), the right pane drops the identity-card padding so
 * `<ComfyUISettingsContent>` can fill the available area edge-to-edge.
 * `.picker-detail-wrap` already has horizontal padding for compact;
 * remove it on the expanded variant. */
.picker-detail-wrap.is-expanded {
  padding: 0;
}
.picker-detail-wrap.is-expanded .picker-detail {
  gap: 0;
}

.picker-expanded-body {
  flex: 1 1 auto;
  min-height: 0;
  /* Brighten dim text inside the embedded settings UI. Most labels +
   * meta strings inside `ComfyUISettingsContent` and its children
   * resolve via `var(--text-muted)`; overriding the token at this
   * scope cascades the bump without touching the shared token. */
  --text-muted: var(--neutral-100);
}

/* ---- Mode-flip cross-fade ----
 * Lands a hair before the main-side 200ms bounds tween so contents
 * settle before the shell does. `mode="out-in"` on the wrapping
 * Transition ensures no overlap → no double-measurement on the
 * ResizeObserver. `will-change` is scoped to the active transition
 * phase so the browser promotes the subtree to its own GPU layer for
 * the fade (avoids per-frame repaints on a heavy `ComfyUISettings-
 * Content` subtree) and then releases the layer once the animation
 * settles — no permanent compositor pressure. */
.picker-mode-enter-active,
.picker-mode-leave-active {
  transition: opacity 160ms ease;
  will-change: opacity;
}
.picker-mode-enter-from,
.picker-mode-leave-to {
  opacity: 0;
}

/* ---- Row enter/leave + FLIP for search/filter changes ----
 * Surviving rows slide via Vue's auto-FLIP; departing rows fade-up,
 * arriving rows fade-down. Keeps the outer popup-height tween from
 * looking teleported when row counts change. */
.picker-row-enter-active,
.picker-row-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}
.picker-row-enter-from {
  opacity: 0;
  transform: translateY(-2px);
}
.picker-row-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}
.picker-row-move {
  transition: transform 160ms ease;
}
/* Leaving rows are taken out of flow so the surrounding FLIP feels
 * snappy instead of waiting for the leave animation to finish. */
.picker-row-leave-active {
  position: absolute;
}

@media (prefers-reduced-motion: reduce) {
  .picker-mode-enter-active,
  .picker-mode-leave-active,
  .picker-row-enter-active,
  .picker-row-leave-active,
  .picker-row-move {
    transition: none;
  }
}
</style>
