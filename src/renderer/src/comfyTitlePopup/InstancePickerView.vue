<script setup lang="ts">
import { computed, ref, toRef, useTemplateRef, watch } from 'vue'
import { useTitlePopupAutoResize } from '../composables/useTitlePopupAutoResize'
import { useI18n } from 'vue-i18n'
import { ChevronRight, ChevronUp, Plus, Search } from 'lucide-vue-next'
import BaseInput from '../components/ui/BaseInput.vue'
import BaseAccordion from '../components/ui/BaseAccordion.vue'
import BaseMenu, { type BaseMenuItem } from '../components/ui/BaseMenu.vue'
import SettingsSectionList from '../views/comfyUISettings/SettingsSectionList.vue'
import PickerSnapshotsList from './instancePicker/PickerSnapshotsList.vue'
import { FILTER_CHIPS, useInstallList } from '../composables/useInstallList'
import { revealInFolderLabel } from '../composables/usePlatform'
import { installTypeMetaFor } from '../lib/installTypeIcon'
import InstanceRow from './instancePicker/InstanceRow.vue'
import type {
  ActionDef,
  DetailField,
  DetailSection,
  Installation,
  SnapshotListData
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
}

const props = defineProps<{
  snapshot: PickerSnapshot
}>()

const { t } = useI18n()

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

// --- selection state ---
//
// Pre-select the host's active install on open. Watch the prop so a
// fresh `set-config` (popover re-opens against a different host)
// re-syncs the selection.
const selectedId = ref<string | null>(props.snapshot.activeInstallationId)
watch(
  () => props.snapshot.activeInstallationId,
  (next) => {
    selectedId.value = next
  }
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

const selectedTypeMeta = computed(() =>
  selectedInstall.value ? installTypeMetaFor(selectedInstall.value.sourceCategory) : null
)

/** Install versions may already include a leading "v"; avoid "vv…". */
const selectedVersionLabel = computed(() => {
  const raw = selectedInstall.value?.version
  if (!raw) return ''
  return raw.startsWith('v') || raw.startsWith('V') ? raw : `v${raw}`
})

const runningSet = computed(() => new Set(props.snapshot.runningInstallationIds))

function isRowRunning(inst: Installation): boolean {
  return runningSet.value.has(inst.id)
}

const isSelectedRunning = computed(
  () => selectedInstall.value != null && runningSet.value.has(selectedInstall.value.id)
)

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

// Per-install "More" menu. Item ids match the `InstallMenuActionId`
// strings `useInstallContextMenu` dispatches on, so the panel-side
// router can hand each id straight to the composable's `triggerAction`
// without a translation table.
const moreMenuItems = computed<BaseMenuItem[]>(() => {
  const inst = selectedInstall.value
  if (!inst) return []
  const isInstalled = inst.status === 'installed'
  const isLocalLike = inst.sourceCategory !== 'cloud'
  const hasPath = !!inst.installPath
  const requiresStoppedDisabled = isSelectedRunning.value
  const items: BaseMenuItem[] = []
  if (hasPath && isLocalLike) {
    items.push({ id: 'reveal-in-folder', label: revealInFolderLabel(bridge?.platform) })
  }
  // Copy Installation — standalone source only (mirrors the
  // composable's gating). REQUIRES_STOPPED.
  if (isInstalled && inst.sourceCategory === 'local') {
    items.push({
      id: 'copy-install',
      label: t('actions.copyInstallation'),
      disabled: requiresStoppedDisabled
    })
  }
  if (isInstalled && isLocalLike) {
    items.push({ id: 'untrack', label: t('actions.untrack') })
  }
  if (isInstalled && isLocalLike) {
    items.push({
      id: 'delete',
      label: t('chooser.menuDelete'),
      style: 'danger',
      separator: true,
      disabled: requiresStoppedDisabled
    })
  }
  return items
})

function handleMoreMenuSelect(id: string): void {
  if (!selectedInstall.value) return
  bridge?.openInstallAction(selectedInstall.value.id, id)
}

function handleOpenButton(): void {
  if (!selectedInstall.value) return
  // Even when the user clicked Open on the host's own install (a
  // visual no-op because main just refocuses the existing window),
  // the picker still dismisses — that's the canonical "I committed"
  // signal back to the user.
  //
  // Branch on running state: a running selected install means "Open"
  // wouldn't do anything visible (main would just refocus the existing
  // window), so the CTA reads "Restart" and dispatches the restart
  // flow — main confirms with a native dialog, stops the session, then
  // re-launches into a fresh Comfy window.
  if (isSelectedRunning.value) {
    bridge?.restartInstall(selectedInstall.value.id)
  } else {
    bridge?.pickInstall(selectedInstall.value.id)
  }
}

const openCtaLabel = computed(() =>
  isSelectedRunning.value ? t('instancePicker.restart') : t('instancePicker.open')
)

function handleNewInstall(): void {
  bridge?.openNewInstall()
}

function handleCloudClick(): void {
  // Cloud row body click = select-only (same switcher contract as the
  // regular install rows). The Open button commits.
  if (cloudInstall.value) {
    selectedId.value = cloudInstall.value.id
  } else {
    // Empty Cloud CTA — no install to select, the click commits
    // directly into the new-install flow.
    bridge?.openNewInstall()
  }
}

const isCloudRowActive = computed(
  () => cloudInstall.value != null && selectedId.value === cloudInstall.value.id
)

// --- Settings + Snapshots accordions (right pane) ---
//
// Selection sync: when the user picks a DIFFERENT install row, tell
// main so it can resolve that install's Settings + Snapshots and push
// a fresh snapshot back. The snapshot prop's `selectedSettings` /
// `selectedSnapshots` carry the resolved data that the accordions
// below render.
//
// No `immediate: true` here: main's click handler already seeded
// `pickerSelectedInstallationId` with the host's active install and
// kicked the initial details fetch before showing the popup. Firing
// this watcher on mount would re-tell main "I selected X" (where X
// is the value main itself just set), causing a snapshot rebroadcast
// → a `pickerSnapshot` prop change → a `measureAndRequestSize` call
// → a `setBounds` on the WebContentsView mid-open-animation. That
// resize was the visible "open → close → open" flicker.
watch(
  () => selectedInstall.value?.id ?? null,
  (next) => {
    bridge?.setPickerSelectedInstall(next)
  }
)

// Per-accordion open state. Both collapsed by default — the popup is
// already a focused glance affordance; expanding takes one click to
// reveal the heavier UI. Keyed by `selectedInstall.value.id` so a
// switch between rows resets the open state (the previous install's
// expansion was scoped to its context).
const settingsOpen = ref(false)
const snapshotsOpen = ref(false)
watch(
  () => selectedInstall.value?.id ?? null,
  () => {
    settingsOpen.value = false
    snapshotsOpen.value = false
  }
)

function toggleSettingsAccordion(): void {
  settingsOpen.value = !settingsOpen.value
}
function toggleSnapshotsAccordion(): void {
  snapshotsOpen.value = !snapshotsOpen.value
}

// Fit-to-content resize for the right-pane Settings / Snapshots
// accordions. The `.picker` root is `height: 100%`-clamped to the
// WebContentsView's current bounds and the `.picker-detail-nav` is
// `overflow-y: auto`, so observing either directly saturates the
// natural-height signal. `detailNavContentRef` sits inside the nav's
// scroll container and reports the unclamped accordion content
// height; `useTitlePopupAutoResize` re-derives total popup height by
// nudging the current root height by the delta between what the nav
// is currently allowed to be vs. what the content wants.
const pickerRootRef = useTemplateRef<HTMLDivElement>('pickerRootRef')
const detailNavRef = useTemplateRef<HTMLDivElement>('detailNavRef')
const detailNavContentRef = useTemplateRef<HTMLDivElement>('detailNavContentRef')

useTitlePopupAutoResize(
  detailNavContentRef,
  () => {
    const root = pickerRootRef.value
    const nav = detailNavRef.value
    const content = detailNavContentRef.value
    if (!root || !nav || !content) return NaN
    // +2 for the `.popup` 1px top + 1px bottom border.
    return root.offsetHeight + (content.offsetHeight - nav.offsetHeight) + 2
  },
  bridge?.requestSize ? bridge.requestSize.bind(bridge) : undefined,
)

// Picker right-pane Settings accordion shows ONLY the Config tab —
// not status / update. Same filter the drawer uses
// (`useComfyUISettings.sectionsForTab('settings')`) just applied
// renderer-side over the already-pushed payload. Status + Update belong
// in the full drawer where there's room for the readonly-list chrome
// and the update-channel controls; the picker accordion is for the
// settings the user actually toggles.
const selectedSettingsSections = computed<DetailSection[]>(() => {
  const all = (props.snapshot.selectedSettings as DetailSection[] | null) ?? []
  return all.filter((s) => s.tab === 'settings')
})
const selectedSnapshotsData = computed<SnapshotListData | null>(
  () => (props.snapshot.selectedSnapshots as SnapshotListData | null) ?? null
)
// Cloud sources don't push a snapshots payload at all (see
// urlSource.ts — only `status` and `settings` sections are emitted),
// so absence of the payload is the same rule the drawer applies
// server-side. Local installs always send one, even when empty —
// PickerSnapshotsList owns the empty state inside the accordion.
const hasSnapshots = computed(() => selectedSnapshotsData.value != null)

async function handlePickerUpdateField(field: DetailField, value: unknown): Promise<void> {
  if (!selectedInstall.value) return
  await bridge?.pickerUpdateField(selectedInstall.value.id, field.id, value)
  // Main rebroadcasts the picker snapshot on success, so the new
  // field value flows back automatically. Errors surface in the
  // returned message — the picker doesn't have its own toast surface
  // yet, so for now we just no-op-on-error (the value visibly snaps
  // back to whatever's in the latest snapshot).
}

async function handlePickerRunAction(action: ActionDef): Promise<void> {
  if (!selectedInstall.value) return
  const id = action.id
  if (id !== 'snapshot-save' && id !== 'snapshot-restore' && id !== 'snapshot-delete') {
    // The shared SettingsSectionList emits all section actions
    // through `run-action`, but the picker only whitelists the
    // snapshot lifecycle. Non-snapshot actions (channel-pick,
    // delete-install, etc.) belong in the full Settings drawer.
    return
  }
  await bridge?.pickerRunAction(selectedInstall.value.id, id)
}

function handleOpenArgsPage(_field: DetailField): void {
  // The args builder is a sub-page nav in the full drawer; the popup
  // doesn't have room for it. Silently no-op here; users who need to
  // edit args open the drawer from the title-bar Settings icon. Field
  // arg is intentionally unused — the picker doesn't expose the args
  // builder yet.
  void _field
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
        v-for="chip in FILTER_CHIPS"
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

    <div class="picker-body">
      <div class="picker-left">
        <div class="picker-list-section">
          <div class="picker-list-section-title">{{ t('instancePicker.instances') }}</div>

          <div class="picker-list" role="listbox">
            <div v-if="showCloudCard" class="picker-row-wrap">
              <button
                type="button"
                class="picker-row picker-row-cloud"
                :class="{ 'is-active': isCloudRowActive }"
                @click="handleCloudClick"
              >
                <div class="picker-row-icon">
                  <component :is="installTypeMetaFor('cloud').icon" :size="20" />
                </div>
                <div class="picker-row-body picker-row-body-single">
                  <div class="picker-row-name">
                    {{ cloudInstall ? cloudInstall.name : t('cloud.label') }}
                  </div>
                </div>
              </button>
            </div>

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

        <button type="button" class="picker-new-install" @click="handleNewInstall">
          <Plus :size="16" />
          <span>{{ t('instancePicker.newInstance') }}</span>
        </button>
      </div>

      <div class="picker-detail-wrap">
        <div class="picker-detail">
          <template v-if="selectedInstall">
            <div class="picker-detail-main">
              <component
                :is="selectedTypeMeta.icon"
                v-if="selectedTypeMeta"
                :size="32"
                class="picker-detail-type-icon"
                :title="t(selectedTypeMeta.labelKey)"
              />
              <div class="picker-detail-text">
                <div class="picker-detail-name">{{ selectedInstall.name }}</div>
                <div class="picker-detail-pills">
                  <span class="picker-detail-pill">{{ t('instancePicker.latestOnGithub') }}</span>
                  <span
                    v-if="selectedInstall.version"
                    class="picker-detail-pill picker-detail-pill-version"
                  >
                    {{ selectedVersionLabel }}
                  </span>
                  <span class="picker-detail-pill">
                    {{ lastLaunchedLabel(selectedInstall) }}
                  </span>
                </div>
              </div>
            </div>

            <div ref="detailNavRef" class="picker-detail-nav picker-compact">
              <div ref="detailNavContentRef" class="picker-detail-nav-content">
              <button
                type="button"
                class="picker-detail-nav-item"
                :aria-expanded="settingsOpen"
                @click="toggleSettingsAccordion"
              >
                <ChevronRight
                  :size="12"
                  aria-hidden="true"
                  class="picker-detail-nav-chevron"
                  :class="{ 'is-open': settingsOpen }"
                />
                <span>{{ t('instancePicker.settings') }}</span>
              </button>
              <BaseAccordion :open="settingsOpen">
                <div class="picker-detail-accordion-body">
                  <SettingsSectionList
                    v-if="selectedSettingsSections.length > 0"
                    :sections="selectedSettingsSections"
                    :installation-id="selectedInstall?.id"
                    @update-field="handlePickerUpdateField"
                    @run-action="handlePickerRunAction"
                    @open-args-page="handleOpenArgsPage"
                  />
                  <div v-else class="picker-detail-empty-inline">
                    {{ t('instancePicker.empty') }}
                  </div>
                </div>
              </BaseAccordion>

              <template v-if="hasSnapshots">
                <button
                  type="button"
                  class="picker-detail-nav-item"
                  :aria-expanded="snapshotsOpen"
                  @click="toggleSnapshotsAccordion"
                >
                  <ChevronRight
                    :size="12"
                    aria-hidden="true"
                    class="picker-detail-nav-chevron"
                    :class="{ 'is-open': snapshotsOpen }"
                  />
                  <span>{{ t('instancePicker.snapshots') }}</span>
                </button>
                <BaseAccordion :open="snapshotsOpen">
                  <div class="picker-detail-accordion-body">
                    <PickerSnapshotsList
                      :data="selectedSnapshotsData"
                      @save="
                        () =>
                          selectedInstall &&
                          bridge?.pickerRunAction(selectedInstall.id, 'snapshot-save')
                      "
                      @restore="
                        (filename) =>
                          selectedInstall &&
                          bridge?.pickerRunAction(selectedInstall.id, 'snapshot-restore', {
                            file: filename
                          })
                      "
                      @delete="
                        (filename) =>
                          selectedInstall &&
                          bridge?.pickerRunAction(selectedInstall.id, 'snapshot-delete', {
                            file: filename
                          })
                      "
                    />
                  </div>
                </BaseAccordion>
              </template>
              </div>
            </div>

            <div class="picker-detail-cta">
              <button type="button" class="picker-detail-open" @click="handleOpenButton">
                {{ openCtaLabel }}
              </button>
              <BaseMenu
                v-if="moreMenuItems.length > 0"
                :items="moreMenuItems"
                align="end"
                :trigger-aria-label="t('chooser.moreActions')"
                class="picker-detail-more"
                @select="handleMoreMenuSelect"
              >
                <span>{{ t('instancePicker.more') }}</span>
                <ChevronUp :size="16" aria-hidden="true" />
              </BaseMenu>
            </div>
          </template>
          <div v-else class="picker-detail-empty">
            {{ t('instancePicker.empty') }}
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
}

.picker-search {
  border-bottom: 1px solid var(--chooser-surface-border);
  padding: 8px 10px 16px 10px;
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
  color: var(--neutral-100);
}
.picker-search :deep(.ui-input-control) {
  padding: 4px 0 0 0;
  font-size: 16px;
  line-height: 24px;
  color: var(--text);
}
.picker-search :deep(.ui-input-control::placeholder) {
  color: var(--neutral-100);
  opacity: 0.67;
}

.picker-search-icon {
  color: var(--accent-label);
  margin-top: 6px;
}
.picker-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid var(--chooser-surface-border);
}
.picker-chip {
  height: 24px;
  padding: 3px 11px;
  border-radius: 9999px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--brand-surface-bg);
  font-size: 12px;
  line-height: 16px;
  color: var(--neutral-100);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition:
    background-color 100ms ease,
    border-color 100ms ease;
}
.picker-chip:hover,
.picker-chip:focus-visible {
  outline: none;
}
.picker-chip.is-active {
  background: var(--chooser-surface-border);
  border-color: var(--brand-surface-border-hover);
}

.picker-body {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  padding: 8px 0px 12px 0;
}

.picker-left {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-right: 1px solid var(--chooser-surface-border);
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
  color: rgba(194, 191, 185, 0.75);
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
  color: var(--neutral-200);
}

.picker-new-install {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  margin: 0 18px;
  padding: 8px 16px 8px 8px;
  border-radius: 8px;
  width: fit-content;
  border: none;
  background: var(--chooser-surface-border);
  color: var(--neutral-100);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.picker-new-install:hover,
.picker-new-install:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

/* Cloud row — mirrors InstanceRow inner chrome. */
.picker-row-wrap {
  padding: 2px 8px;
  width: 100%;
  box-sizing: border-box;
}
.picker-row {
  display: grid;
  grid-template-columns: 24px 1fr;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 8px 8px 10px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  color: inherit;
  font: inherit;
  text-align: left;
  background: transparent;
  transition: background-color 120ms ease;
}
.picker-row:hover,
.picker-row:focus-visible {
  background: var(--chooser-surface-border);
  outline: none;
}
.picker-row.is-active {
  background: var(--chooser-surface-border);
}
.picker-row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--accent-label);
}
.picker-row-body {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  overflow: hidden;
}
.picker-row-body-single {
  align-items: center;
}
.picker-row-name {
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
  color: var(--neutral-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-detail-wrap {
  min-width: 0;
  min-height: 0;
  padding: 0 8px;
  display: flex;
  overflow: hidden;
}
.picker-detail {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.picker-detail-main {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.picker-detail-type-icon {
  color: var(--accent-label);
  flex: 0 0 auto;
}
.picker-detail-text {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.picker-detail-name {
  font-size: 16px;
  font-weight: 600;
  line-height: 24px;
  color: var(--neutral-100);
}
.picker-detail-pills {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.picker-detail-pill {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 3px 11px;
  border-radius: 9999px;
  background: var(--brand-surface-bg);
  border: 1px solid var(--chooser-surface-border);
  font-size: 12px;
  line-height: 16px;
  color: var(--neutral-100);
  white-space: nowrap;
}
.picker-detail-pill-version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.picker-detail-nav {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding-top: 16px;
  border-top: 1px solid var(--chooser-surface-border);
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

/* Holds the Settings + Snapshots accordion buttons; the parent nav
 * owns the scroll container so this wrapper reports the unclamped
 * natural content height to the ResizeObserver hooked up in
 * `InstancePickerView`. */
.picker-detail-nav-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.picker-detail-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--neutral-100);
  font-size: 14px;
  line-height: normal;
  cursor: pointer;
  text-align: left;
}
.picker-detail-nav-item:hover,
.picker-detail-nav-item:focus-visible {
  opacity: 0.85;
  outline: none;
}
.picker-detail-nav-chevron {
  transition: transform 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.picker-detail-nav-chevron.is-open {
  transform: rotate(90deg);
}
.picker-detail-accordion-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* Compact density inside the picker's Settings / Snapshots accordions.
   The drawer keeps roomier defaults; one step smaller type + neutral-100
   text so controls read as secondary chrome. */
.picker-compact .picker-detail-accordion-body {
  padding-top: 6px;
  gap: 8px;
}
.picker-compact .picker-detail-empty-inline {
  font-size: 11px;
  line-height: 16px;
  color: var(--neutral-100);
  opacity: 0.67;
  padding: 4px 0;
}
.picker-compact :deep(.settings-v2-field) {
  gap: 4px;
}
.picker-compact :deep(.settings-v2-section-title),
.picker-compact :deep(.settings-v2-item),
.picker-compact :deep(.settings-v2-field-label),
.picker-compact :deep(.settings-v2-field-readonly),
.picker-compact :deep(.ui-input-control),
.picker-compact :deep(.ui-select-trigger),
.picker-compact :deep(.bt-switch),
.picker-compact :deep(.env-var-add),
.picker-compact :deep(.channel-picker-value) {
  color: var(--neutral-100);
}
.picker-compact :deep(.settings-v2-section-title),
.picker-compact :deep(.settings-v2-item),
.picker-compact :deep(.settings-v2-field-label),
.picker-compact :deep(.settings-v2-field-readonly),
.picker-compact :deep(.ui-input-control),
.picker-compact :deep(.ui-select-trigger),
.picker-compact :deep(.bt-switch),
.picker-compact :deep(.env-var-add) {
  font-size: 13px;
  line-height: 18px;
}
.picker-compact :deep(.settings-v2-section-desc),
.picker-compact :deep(.channel-picker-desc),
.picker-compact :deep(.channel-picker-label) {
  font-size: 11px;
  line-height: 16px;
  color: var(--neutral-100);
  opacity: 0.67;
}
.picker-compact :deep(.channel-picker-value) {
  font-size: 13px;
  line-height: 19px;
}
.picker-compact :deep(.channel-picker-value.is-update-available) {
  color: var(--info);
}
.picker-compact :deep(.ui-input-control::placeholder),
.picker-compact :deep(.ui-select-trigger[data-placeholder] .ui-select-label) {
  color: var(--neutral-100);
  opacity: 0.67;
}
.picker-compact :deep(.picker-snapshots-list) {
  gap: 8px;
}
.picker-compact :deep(.picker-snapshots-save),
.picker-compact :deep(.picker-snapshots-empty),
.picker-compact :deep(.picker-snapshot-summary-line),
.picker-compact :deep(.picker-snapshot-action) {
  font-size: 11px;
  line-height: 16px;
  color: var(--neutral-100);
}
.picker-compact :deep(.snapshot-row-card) {
  padding: 6px;
}
.picker-compact :deep(.snapshot-row-trigger),
.picker-compact :deep(.snapshot-row-time) {
  font-size: 11px;
  line-height: 16px;
  color: var(--neutral-100);
}
.picker-compact :deep(.snapshot-row-trigger[data-tone='state']) {
  color: var(--warning);
}
.picker-compact :deep(.snapshot-row-current) {
  font-size: 10px;
  line-height: 15px;
}
.picker-compact :deep(.snapshot-row-chip),
.picker-compact :deep(.snapshot-row-meta) {
  font-size: 10px;
  line-height: 14px;
  color: var(--neutral-100);
  opacity: 0.67;
}
.picker-compact :deep(.args-field-ac-item) {
  font-size: 11px;
  color: var(--neutral-100);
}
.picker-compact :deep(.args-field-ac-meta),
.picker-compact :deep(.args-field-ac-help),
.picker-compact :deep(.args-field-ac-hint) {
  font-size: 10px;
  color: var(--neutral-100);
  opacity: 0.67;
}
.picker-detail-cta {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.picker-detail-open {
  flex: 1 1 auto;
  min-height: 32px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--accent-primary, #0b8ce9);
  background: var(--accent-primary, #0b8ce9);
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  line-height: normal;
  cursor: pointer;
  transition: filter 100ms ease;
}
.picker-detail-open:hover,
.picker-detail-open:focus-visible {
  filter: brightness(1.08);
  outline: none;
}

.picker-detail-more {
  flex: 0 0 auto;
}
.picker-detail-empty {
  margin: auto;
  font-size: 14px;
  color: var(--neutral-100);
  opacity: 0.7;
}
</style>
