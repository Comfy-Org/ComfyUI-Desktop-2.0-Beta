<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle, XCircle, ChevronUp, HardDrive, SlidersHorizontal, Info, RefreshCw, History } from 'lucide-vue-next'
import { useComfyUISettings } from '../../composables/useComfyUISettings'
import { useSessionStore } from '../../stores/sessionStore'
import { findActionById } from '../../lib/findAction'
import MoreMenu from '../../views/comfyUISettings/MoreMenu.vue'
import ArgsBuilderPage from '../../views/comfyUISettings/ArgsBuilderPage.vue'
import SnapshotsView from '../../views/comfyUISettings/SnapshotsView.vue'
import StatusFactPanel from '../../views/comfyUISettings/StatusFactPanel.vue'
import SettingsSectionList from '../../views/comfyUISettings/SettingsSectionList.vue'
import StoragePane, { type StorageSnapshot } from '../../views/comfyUISettings/StoragePane.vue'
import Tooltip from '../ui/Tooltip.vue'
import type { PickerTab, SectionTab } from '../../lib/pickerTabs'
import { humanizeOpStatus } from '../../lib/progressStatusLabel'
import type { ActionDef, DetailField, Installation, ShowProgressOpts } from '../../types/ipc'
import { TID } from '../../../../shared/testIds'

/**
 * Per-install settings body (tab strip + scrollable body + footer).
 * Extracted from `ComfyUISettingsPanel.vue` so the same UI can be hosted
 * by both the drawer chrome and the instance-picker's expanded right
 * pane. The host owns slide-in / popup chrome, focus trap, ESC/Tab and
 * backdrop dismissal; this component is the pure inner UI.
 */

export type ComfyUISettingsTab = PickerTab

interface ActiveOperation {
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

interface Props {
  installation: Installation | null
  initialTab?: ComfyUISettingsTab
  /** Optional action id to fire automatically once `sections` are
   *  loaded — mirrors `DetailModal`'s `autoAction` prop. Used by the
   *  picker's expanded mode when opened via dashboard kebab
   *  `Copy Installation` / `Untrack` / `Delete` / `Migrate to
   *  Standalone`. Consumed exactly once per (autoAction, autoActionNonce)
   *  transition; later section reloads or selection changes do not
   *  re-fire. */
  autoAction?: string | null
  /** Bumped by the picker on each explicit (re)open that seeds an
   *  `autoAction`. The picker popup is cached, so a repeat trigger
   *  re-sends the same `autoAction` value — keying the consumed-guard on
   *  this nonce lets a second click re-fire. Absent (drawer host) → the
   *  guard falls back to value-only keying. */
  autoActionNonce?: number
  /** Slice of the popup's global-settings snapshot consumed by the
   *  Storage tab. Optional so non-popup hosts (e.g. drawer chrome)
   *  can omit it and the Storage tab silently empties out — they
   *  don't have a way to mutate global settings anyway. */
  globalSettingsSnapshot?: StorageSnapshot
  /** Live operation status for an in-flight or recently-completed
   *  background op on this install (cross-instance update etc.).
   *  When set and the active tab is `'update'`, the Update tab body
   *  is replaced with an inline progress / result view. */
  activeOperation?: ActiveOperation | null
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'update',
  showBack: false,
  autoAction: null,
  autoActionNonce: 0,
  activeOperation: null,
  globalSettingsSnapshot: () => ({
    sharedDirectoriesFields: [],
    modelsDirs: [],
    modelsSystemDefault: '',
  }),
})

const emit = defineEmits<{
  'show-progress': [opts: ShowProgressOpts]
  /** Action's `result.navigate === 'list'` — install was removed. The
   *  host should close itself and tear down the comfy window. */
  'navigate-list': []
  /** Composable requested host dismissal (currently fires alongside
   *  `navigate-list` so the host can animate out before navigation). */
  'request-close': []
  /** Footer primary CTA — host decides whether to call its bridge's
   *  `pickInstall` (not-running case → Open) or `restartInstall`
   *  (running case → Restart) so the same native-confirm flow runs
   *  whether the affordance is clicked from the compact row or the
   *  expanded view's footer. Payload carries the running flag so the
   *  host doesn't have to re-derive it. */
  'primary-action': [running: boolean]
  /** Inline progress CTA events — forwarded up to the host which owns
   *  the bridge methods for cancel / retry / dismiss. */
  'op-cancel': []
  'op-retry': []
  'op-dismiss': []
}>()

const { t } = useI18n()

const activeTab = ref<ComfyUISettingsTab>(props.initialTab)

watch(
  () => props.initialTab,
  (next) => {
    activeTab.value = next
  }
)

watch(
  () => props.installation?.id ?? null,
  (next, prev) => {
    if (next !== prev) activeTab.value = props.initialTab
  }
)

const installation = toRef(props, 'installation')
const sessionStore = useSessionStore()
const {
  sections,
  loading,
  error,
  notice,
  updateField,
  pendingRestartFieldIds,
  fieldErrorMessages,
  runAction,
  runningActionIds,
  sectionsForTab,
  diskUsageItem,
  pinBottomActions,
  reload
} = useComfyUISettings({
  installation,
  onShowProgress: (opts) => emit('show-progress', opts),
  onNavigateList: () => emit('navigate-list'),
  onClose: () => emit('request-close')
})

// `autoAction` consumption — fires the named action once per prop
// transition, after sections have loaded for the current install.
// Used by dashboard kebab `Copy Installation` / `Untrack` (and the
// existing `Migrate to Standalone` / `Delete` routes) which open the
// picker in expanded mode with an `autoAction` seed so the source-
// action def's confirm/prompt/disk-check chain actually fires —
// otherwise the picker would just open with the user staring at a
// settings tab.
//
// Guards:
//   - keyed on `autoAction` + the picker's `autoActionNonce` (not the
//     install id) so re-mounts / section reloads on the same trigger
//     don't double-fire, AND a repeat trigger of the SAME action still
//     re-fires (the picker popup is cached, so the value alone doesn't
//     transition — the nonce bumps on each explicit re-open). Picking a
//     different install while the key sticks around can't auto-run a
//     destructive op on the new install (re-checked after the tick).
//   - reset when the key transitions, so the next trigger can fire.
const autoActionKey = computed<string | null>(() =>
  props.autoAction ? `${props.autoAction}#${props.autoActionNonce ?? 0}` : null
)
const consumedAutoActionKey = ref<string | null>(null)
watch(autoActionKey, (next, prev) => {
  if (next !== prev) consumedAutoActionKey.value = null
})
watch(
  [
    () => autoActionKey.value,
    () => props.installation?.id ?? null,
    () => loading.value,
    () => sections.value.length
  ],
  async ([key, installId, isLoading, sectionsLen]) => {
    if (!installId || !key || isLoading || sectionsLen === 0) return
    if (consumedAutoActionKey.value === key) return
    const autoAction = props.autoAction
    if (!autoAction) return

    // Mirror `DetailModal`'s channel-card-aware resolution so that
    // nested per-channel actions (`update-comfyui`, `copy-update`,
    // `switch-channel`) target the install's currently-selected
    // channel rather than an arbitrary other channel's same-id action.
    const channelField = sections.value
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.editType === 'channel-cards')
    const currentChannel = typeof channelField?.value === 'string' ? channelField.value : null
    const action = findActionById(sections.value, autoAction, currentChannel)
    if (!action) return

    consumedAutoActionKey.value = key
    await nextTick()

    // Re-check the install after the tick — selection can change in
    // the meantime (the popup is one mount across install switches),
    // and `runAction` reads the current installation at call time. A
    // stale invocation would auto-fire a destructive op against the
    // wrong install.
    if (props.installation?.id !== installId) return

    void runAction(action)
  },
  { immediate: true }
)

// Auto-refresh stale channel-cards when the Update tab opens. The
// release cache persists to disk forever and only refreshes on
// explicit "Check for Update" clicks, post-update-comfyui, or install
// creation — without this watcher, a user who opens the picker days
// or weeks after install sees a snapshot of release data from the
// last manual check. Fires `check-update` (cheap GitHub tag fetch,
// deduped main-side by `MIN_RECHECK_INTERVAL = 10s` inside the release
// cache) whenever:
//
//   - the active tab is `'update'`,
//   - the sections payload has a channel-cards field,
//   - and the currently-selected option's `data.checkedAt` is missing
//     or older than `STALE_CHANNEL_CARD_MS`.
//
// Per-(install, channel) dedupe via `refreshedChannelKeys` so tab
// flips don't spam IPCs. Main's `getOrFetch(..., force=true)` short-
// circuits on the 10s window so even a stuck renderer can't push more
// than 6 fetches/minute/channel.
const refreshedChannelKeys = new Set<string>()
watch(
  [() => activeTab.value, () => props.installation?.id ?? null, () => sections.value.length],
  ([tab, installId, sectionsLen]) => {
    if (tab !== 'update' || !installId || sectionsLen === 0) return

    const channelField = sections.value
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.editType === 'channel-cards')
    if (!channelField) return

    const currentChannel = typeof channelField.value === 'string' ? channelField.value : null
    if (!currentChannel) return

    // Look up the canonical action def from sections so we inherit
    // whatever `enabled` / disabledMessage / future fields main attaches
    // (today: `enabled: installed`). Bail if main isn't exposing the
    // action for this install (e.g. uninstalled / cloud).
    const checkAction = sections.value
      .flatMap((s) => s.actions ?? [])
      .find((a) => a.id === 'check-update')
    if (!checkAction || checkAction.enabled === false) return

    const dedupeKey = `${installId}:${currentChannel}`
    if (refreshedChannelKeys.has(dedupeKey)) return
    refreshedChannelKeys.add(dedupeKey)

    // `check-update` has no `showProgress` / confirm / prompt; it runs
    // inline via `useComfyUISettings.runAction` step 10. A successful
    // result returns `navigate: 'detail'` → section reload → fresh
    // `checkedAt` bubbles through this watcher (dedupe set prevents
    // re-fire on the same install+channel).
    //
    // `silent: true` — this is the automatic on-tab-open refresh, not a
    // user click, so it must not pop the "you're up to date" alert that a
    // manual check does.
    void runAction({ ...checkAction, data: { ...checkAction.data, silent: true } })
  },
  { immediate: true }
)

interface TabDef {
  key: ComfyUISettingsTab
  sectionTab: SectionTab
  label: string
  icon: typeof SlidersHorizontal
}

const ALL_TABS: TabDef[] = [
  {
    key: 'update',
    sectionTab: 'update',
    label: t('comfyUISettings.tabUpdate', 'Update'),
    icon: RefreshCw
  },
  {
    key: 'config',
    sectionTab: 'settings',
    label: t('comfyUISettings.tabConfig', 'Startup Args'),
    icon: SlidersHorizontal
  },
  {
    key: 'snapshots',
    sectionTab: 'snapshots',
    label: t('comfyUISettings.tabSnapshots', 'Snapshots'),
    icon: History
  },
  {
    key: 'storage',
    sectionTab: 'storage',
    label: t('comfyUISettings.tabStorage', 'Storage'),
    icon: HardDrive
  },
  {
    key: 'status',
    sectionTab: 'status',
    label: t('comfyUISettings.tabStatus', 'About'),
    icon: Info
  }
]
const tabs = computed<TabDef[]>(() =>
  ALL_TABS.filter((tab) => sectionsForTab(tab.sectionTab).value.length > 0)
)

const showUpdateBadge = computed(() => {
  const inst = installation.value
  return inst?.statusTag?.style === 'update' || inst?.status === 'update-available'
})

// If the currently selected tab disappeared (e.g. swapping a local
// install for a cloud one while open), fall back to the requested
// `initialTab` if it's now available, otherwise the first surviving
// tab. This matters at first mount: sections load async, so the
// initial `tabs` list is empty and the requested tab (e.g.
// `'snapshots'` from a kebab deep link) isn't yet present. When the
// sections land, prefer the requested tab over `next[0]` so deep
// links honour the caller's intent instead of always falling back to
// Config.
watch(tabs, (next) => {
  if (next.length === 0) return
  if (next.some((tab) => tab.key === activeTab.value)) return
  const requested = next.find((tab) => tab.key === props.initialTab)
  activeTab.value = requested ? requested.key : next[0]!.key
})

const visibleSections = computed(() => {
  const tab = tabs.value.find((tt) => tt.key === activeTab.value)?.sectionTab ?? 'settings'
  return sectionsForTab(tab).value
})

const statusSections = computed(() => sectionsForTab('status').value)

const storageSections = computed(() => sectionsForTab('storage').value)

const rootRef = useTemplateRef<HTMLElement>('root')

function handleTabKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  event.preventDefault()
  const delta = event.key === 'ArrowRight' ? 1 : -1
  const next = (index + delta + tabs.value.length) % tabs.value.length
  const nextKey = tabs.value[next]?.key
  if (nextKey) {
    selectTab(nextKey)
    nextTick(() => {
      const buttons = rootRef.value?.querySelectorAll<HTMLButtonElement>('.settings-v2-tab')
      buttons?.[next]?.focus()
    })
  }
}

// Footer "More" dropdown state. The menu component owns its own
// outside-click + ESC handlers and emits `close` when the user dismisses
// it that way.
const moreMenuOpen = ref(false)
function toggleMoreMenu(): void {
  moreMenuOpen.value = !moreMenuOpen.value
}
function closeMoreMenu(): void {
  moreMenuOpen.value = false
}

// Drawer sub-page state. When set, the body swaps to the dedicated
// sub-page (e.g. the args builder) instead of the tab list. Tab switch
// also resets the sub-page so the args editor never orphans over a
// different tab's content.
type SubPage = 'args' | null
const subPage = ref<SubPage>(null)
// Direction of the sub-page transition. Push = forward (slide in from
// right). Pop = back (slide out to right).
const subPageTransition = ref<'subpage-push' | 'subpage-pop'>('subpage-push')
function openArgsPage(): void {
  subPageTransition.value = 'subpage-push'
  subPage.value = 'args'
}
function closeSubPage(): void {
  subPageTransition.value = 'subpage-pop'
  subPage.value = null
}

// Tab-swap transition direction. Forward = the user moved right
// along the tab strip (Config → Status → Update → Snapshots),
// backward = the user moved left. Reuses the existing
// `subpage-push` / `subpage-pop` keyframes so all main-pane motion
// in this component speaks one language. We compare tab *indices*
// from the visible `tabs` list (not the static ALL_TABS order)
// because cloud installs hide Update + Snapshots — swapping
// Config ↔ Status on a cloud install should still feel right.
const tabTransition = ref<'subpage-push' | 'subpage-pop'>('subpage-push')

function selectTab(key: ComfyUISettingsTab): void {
  if (subPage.value !== null) subPageTransition.value = 'subpage-pop'
  if (key !== activeTab.value) {
    const list = tabs.value
    const fromIdx = list.findIndex((t) => t.key === activeTab.value)
    const toIdx = list.findIndex((t) => t.key === key)
    if (fromIdx >= 0 && toIdx >= 0) {
      tabTransition.value = toIdx > fromIdx ? 'subpage-push' : 'subpage-pop'
    }
  }
  activeTab.value = key
  subPage.value = null
}

// Reset the sub-page + close the More menu when the install changes —
// re-mounting between installs starts fresh.
watch(
  () => props.installation?.id ?? null,
  () => {
    subPage.value = null
    moreMenuOpen.value = false
  }
)

const argsField = computed<DetailField | null>(() => {
  for (const s of sectionsForTab('settings').value) {
    for (const f of s.fields ?? []) {
      if (f.editType === 'args-builder') return f
    }
  }
  return null
})

const argsValue = computed(() => {
  const v = argsField.value?.value
  return typeof v === 'string' ? v : v == null ? '' : String(v)
})

function handleArgsUpdate(value: string): void {
  const f = argsField.value
  if (f) void updateField(f, value)
}

function handleSnapshotAction(action: ActionDef): void {
  void runAction(action)
}

function handleSnapshotsRefresh(): void {
  void reload()
}

/** Footer primary CTA — host-agnostic. The host (picker / drawer)
 *  receives `primary-action` with the current running state and
 *  dispatches its own bridge call: `restartInstall` when running,
 *  `pickInstall` when not. This keeps the same native-confirm flow
 *  the compact PickerRow already uses for its Open/Restart button,
 *  so both surfaces share one underlying path. */
const isInstallRunning = computed(() => {
  const inst = installation.value
  return inst ? sessionStore.isRunning(inst.id) : false
})

const hasPendingRestart = computed(
  () => isInstallRunning.value && pendingRestartFieldIds.value.size > 0
)

const primaryActionLabel = computed(() => {
  if (hasPendingRestart.value) {
    return t('instancePicker.restartToApply', 'Restart to apply changes')
  }
  return isInstallRunning.value
    ? t('instancePicker.restart', 'Restart')
    : t('instancePicker.open', 'Open')
})

function handlePrimaryAction(): void {
  if (!installation.value) return
  emit('primary-action', isInstallRunning.value)
}

// Inline-progress state derived from the `activeOperation` prop.
const opInflight  = computed(() => props.activeOperation != null && !props.activeOperation.done)
const opSuccess   = computed(() => props.activeOperation?.done === true && props.activeOperation.ok === true)
const opError     = computed(() => props.activeOperation?.done === true && props.activeOperation.ok === false && props.activeOperation.error !== 'Cancelled.')
const opCancelled = computed(() => props.activeOperation?.done === true && props.activeOperation.error === 'Cancelled.')

const opProgressPct     = computed(() => Math.min(100, Math.max(0, props.activeOperation?.percent ?? 0)))
const opIsIndeterminate = computed(() => (props.activeOperation?.percent ?? -1) < 0 && !props.activeOperation?.done)

const opStatusLabel = computed(() => {
  const op = props.activeOperation
  if (!op) return ''
  if (opCancelled.value) return t('instancePicker.progressCancelled')
  if (opError.value)     return op.error ?? t('instancePicker.progressError')
  if (opSuccess.value)   return opSuccessLabel.value
  return humanizeOpStatus(op.status, t)
})

const opIsDowngrade = computed(
  () => props.activeOperation?.actionId === 'update-comfyui'
    && (props.activeOperation.actionData as { isDowngrade?: boolean } | undefined)?.isDowngrade === true
)

const opTitleLabel = computed(() => {
  if (!props.activeOperation) return ''
  return opIsDowngrade.value
    ? t('instancePicker.progressDowngrading')
    : t('instancePicker.progressUpdating')
})

const opSuccessLabel = computed(() =>
  opIsDowngrade.value
    ? t('instancePicker.progressDowngraded')
    : t('instancePicker.progressSuccessStopped')
)

// Network speed label — only shown when a real speed value exists.
function formatSpeed(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  if (bps >= 1_000)     return `${Math.round(bps / 1_000)} KB/s`
  return `${Math.round(bps)} B/s`
}
const opSpeedLabel = computed(() => {
  const spd = props.activeOperation?.speedBytesPerSec
  return (spd != null && spd > 0) ? formatSpeed(spd) : null
})

// Show overlay when Update tab is active AND op is present.
const showOpOverlay = computed(
  () => activeTab.value === 'update' && props.activeOperation != null
)

// Block footer while in-flight.
const opBlocksFooter = computed(() => opInflight.value)

// Auto-dismiss countdown on success (3 → 2 → 1 → dismiss).
const successCountdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

function clearCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
  successCountdown.value = 0
}

watch(opSuccess, (yes) => {
  if (!yes) { clearCountdown(); return }
  // Reload sections immediately so installed version + update badge
  // reflect the new state as soon as the overlay dismisses.
  void reload()
  // Clear the channel-check dedup key so the auto-refresh watcher
  // can re-fire check-update after the overlay goes away.
  const installId = props.installation?.id
  if (installId) {
    for (const key of Array.from(refreshedChannelKeys)) {
      if (key.startsWith(`${installId}:`)) refreshedChannelKeys.delete(key)
    }
  }
  successCountdown.value = 3
  countdownTimer = setInterval(() => {
    successCountdown.value -= 1
    if (successCountdown.value <= 0) {
      clearCountdown()
      emit('op-dismiss')
    }
  }, 1000)
})

// Close the More menu if it's open when an op begins — otherwise it
// becomes an island of clickable rows on a footer button that's about
// to gray out.
watch(opInflight, (yes) => {
  if (yes && moreMenuOpen.value) closeMoreMenu()
})

onUnmounted(clearCountdown)

defineExpose({
  /** Host can force-focus the active tab — drawer uses this when it
   *  opens so initial focus lands inside the body. */
  focusActiveTab(): void {
    const firstTab = rootRef.value?.querySelector<HTMLButtonElement>('.settings-v2-tab.is-active')
    firstTab?.focus()
  }
})
</script>

<template>
  <div ref="root" class="settings-v2-content">
    <nav
      class="settings-v2-tabs"
      :class="{ 'is-subpage-active': subPage !== null }"
      role="tablist"
      :aria-label="t('comfyUISettings.title', 'Settings')"
      :aria-hidden="subPage !== null"
    >
      <Tooltip
        v-for="(tab, i) in tabs"
        :key="tab.key"
        :text="tab.label"
        side="bottom"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :tabindex="activeTab === tab.key ? 0 : -1"
          class="settings-v2-tab"
          :class="{ 'is-active': activeTab === tab.key }"
          @click="selectTab(tab.key)"
          @keydown="handleTabKeydown($event, i)"
        >
          <span class="settings-v2-tab-icon-wrap">
            <component :is="tab.icon" :size="14" aria-hidden="true" class="settings-v2-tab-icon" />
            <span
              v-if="tab.key === 'update' && showUpdateBadge"
              class="settings-v2-tab-badge"
              aria-hidden="true"
            ></span>
          </span>
          <span>{{ tab.label }}</span>
        </button>
      </Tooltip>
    </nav>

    <section class="settings-v2-body">
      <p v-if="!installation" class="empty">
        {{ t('comfyUISettings.emptyInstallLess', 'Open a ComfyUI install to view its settings.') }}
      </p>
      <p
        v-else-if="loading && !visibleSections.length"
        class="empty"
        :data-testid="TID.pickerSettingsLoading"
      >
        {{ t('common.loading', 'Loading…') }}
      </p>
      <p v-else-if="error" class="empty error">{{ error }}</p>

      <Transition v-else :name="subPageTransition" mode="out-in">
        <ArgsBuilderPage
          v-if="subPage === 'args' && installation"
          key="subpage-args"
          :installation-id="installation.id"
          :initial-value="argsValue"
          @back="closeSubPage"
          @update="handleArgsUpdate"
        />

        <div
          v-else
          key="subpage-root"
          class="settings-v2-body-root"
          :data-testid="TID.pickerSettingsSections"
          :data-install-id="installation?.id"
        >
          <!-- Inner tab-swap transition. Wrapped in a single-root
               `<div>` because `<Transition>` requires one child. -->
          <Transition :name="tabTransition" mode="out-in">
            <div
              v-if="activeTab === 'snapshots' && installation"
              key="tab-snapshots"
              class="settings-v2-tab-pane"
            >
              <SnapshotsView
                :installation-id="installation.id"
                :active-operation="activeOperation"
                @run-action="handleSnapshotAction"
                @refresh-all="handleSnapshotsRefresh"
                @op-cancel="emit('op-cancel')"
                @op-retry="emit('op-retry')"
                @op-dismiss="emit('op-dismiss')"
              />
            </div>
            <div
              v-else-if="activeTab === 'status' && installation"
              key="tab-status"
              class="settings-v2-tab-pane"
            >
              <StatusFactPanel
                :installation="installation"
                :sections="statusSections"
                :disk-usage="diskUsageItem"
              />
            </div>
            <div
              v-else-if="activeTab === 'storage'"
              key="tab-storage"
              class="settings-v2-tab-pane"
            >
              <!-- Lazy-mounted via `v-else-if` so picker opens that
                   never visit Storage don't render the global model-
                   dir UI. Snapshot is owned by the popup root and
                   threaded through here as a prop. -->
              <StoragePane
                :installation="installation"
                :snapshot="globalSettingsSnapshot"
                :sections="storageSections"
                :pending-restart-field-ids="pendingRestartFieldIds"
                :field-error-messages="fieldErrorMessages"
                :running-action-ids="runningActionIds"
                @update-field="updateField"
              />
            </div>
            <div v-else :key="`tab-${activeTab}`" class="settings-v2-tab-pane">
              <!-- Inline progress overlay: shown when an active operation
                   is tracked for this install and the Update tab is open.
                   The SettingsSectionList fades out; the progress view
                   fades in within the same content area. -->
              <Transition name="op-overlay" mode="out-in">
                <div v-if="showOpOverlay" key="op-overlay" class="op-overlay">

                  <!-- In-flight -->
                  <template v-if="opInflight">
                    <p class="op-title">{{ opTitleLabel }}</p>
                    <p class="op-name">{{ installation?.name }}</p>

                    <div
                      class="op-bar-wrap"
                      role="progressbar"
                      :aria-valuenow="opIsIndeterminate ? undefined : opProgressPct"
                      aria-valuemin="0"
                      aria-valuemax="100"
                    >
                      <div class="op-bar-header">
                        <span class="op-bar-status">{{ opStatusLabel }}</span>
                        <span class="op-bar-right">
                          <span v-if="opSpeedLabel" class="op-speed">{{ opSpeedLabel }}</span>
                          <span v-if="!opIsIndeterminate" class="op-pct">{{ opProgressPct }}%</span>
                        </span>
                      </div>
                      <div class="op-bar-track">
                        <div
                          class="op-bar-fill"
                          :class="{ 'is-indeterminate': opIsIndeterminate }"
                          :style="opIsIndeterminate ? {} : { width: `${opProgressPct}%` }"
                        />
                      </div>
                    </div>

                    <button
                      v-if="activeOperation?.cancellable"
                      type="button"
                      class="op-ghost-btn"
                      @click="emit('op-cancel')"
                    >
                      {{ t('instancePicker.progressCancel') }}
                    </button>
                  </template>

                  <!-- Success -->
                  <template v-else-if="opSuccess">
                    <div class="op-icon op-icon--success">
                      <CheckCircle :size="32" />
                    </div>
                    <p class="op-title">{{ opSuccessLabel }}</p>
                    <p class="op-name">{{ installation?.name }}</p>
                    <p v-if="successCountdown > 0" class="op-countdown">
                      {{ t('instancePicker.progressSuccessCountdown', { n: successCountdown }) }}
                    </p>
                  </template>

                  <!-- Error -->
                  <template v-else-if="opError">
                    <div class="op-icon op-icon--error">
                      <XCircle :size="32" />
                    </div>
                    <p class="op-title op-title--error">{{ t('instancePicker.progressError') }}</p>
                    <p class="op-name op-name--error">{{ activeOperation?.error }}</p>
                    <div class="op-actions">
                      <button type="button" class="op-primary-btn" @click="emit('op-retry')">
                        {{ t('instancePicker.progressRetry') }}
                      </button>
                      <button type="button" class="op-ghost-btn" @click="emit('op-dismiss')">
                        {{ t('instancePicker.progressDismiss') }}
                      </button>
                    </div>
                  </template>

                  <!-- Cancelled -->
                  <template v-else-if="opCancelled">
                    <p class="op-title op-title--muted">{{ t('instancePicker.progressCancelled') }}</p>
                    <button type="button" class="op-ghost-btn" @click="emit('op-dismiss')">
                      {{ t('instancePicker.progressDismiss') }}
                    </button>
                  </template>

                </div>

                <div v-else key="sections" class="settings-v2-tab-pane">
                  <SettingsSectionList
                    :sections="visibleSections"
                    :installation-id="installation?.id"
                    :running-action-ids="runningActionIds"
                    :pending-restart-field-ids="pendingRestartFieldIds"
                    :field-error-messages="fieldErrorMessages"
                    @update-field="updateField"
                    @run-action="runAction"
                    @open-args-page="openArgsPage"
                  />
                </div>
              </Transition>
            </div>
          </Transition>
        </div>
      </Transition>
    </section>

    <footer class="settings-v2-footer">
      <Transition name="settings-v2-notice-fade">
        <span v-if="notice" class="settings-v2-notice" role="status" aria-live="polite">
          {{ notice }}
        </span>
      </Transition>

      <button
        type="button"
        class="primary settings-v2-relaunch"
        :class="{ 'is-pending-restart': hasPendingRestart }"
        :disabled="!installation || opBlocksFooter"
        @click="handlePrimaryAction"
      >
        {{ primaryActionLabel }}
      </button>

      <div class="settings-v2-more-wrap">
        <button
          type="button"
          class="settings-v2-more"
          data-more-trigger
          :class="{ 'is-active': moreMenuOpen }"
          aria-haspopup="menu"
          :aria-expanded="moreMenuOpen"
          :aria-label="t('comfyUISettings.more', 'More')"
          :disabled="!installation || pinBottomActions.length === 0 || opInflight"
          @click="toggleMoreMenu"
        >
          {{ t('comfyUISettings.more', 'More') }}
          <ChevronUp :size="14" />
        </button>
        <MoreMenu
          :open="moreMenuOpen"
          :actions="pinBottomActions"
          @close="closeMoreMenu"
          @pick="runAction"
        />
      </div>
    </footer>
  </div>
</template>

<style scoped>
.settings-v2-content {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.settings-v2-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 12px;
  border-bottom: 1px solid var(--chooser-surface-border);
  container-type: inline-size;
  container-name: settings-tabs;
}

/* Narrow right-pane: inactive tabs collapse to icon-only, active tab
   keeps its label so "you are here" stays obvious. Tooltip exposes the
   label on hover/focus for the collapsed tabs. */
@container settings-tabs (max-width: 520px) {
  .settings-v2-tab:not(.is-active) {
    padding: 6px 8px;
    gap: 0;
  }
  /* Collapse to icon-only: hide the label but keep the icon wrap (which
     carries the overlapped update dot). */
  .settings-v2-tab:not(.is-active) > span:not(.settings-v2-tab-icon-wrap) {
    display: none;
  }
}

.settings-v2-tabs.is-subpage-active {
  opacity: 0.35;
  pointer-events: none;
}

.settings-v2-tab {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--neutral-100);
  opacity: 0.72;
  font-size: 13px;
  font-weight: 400;
  transition:
    color 120ms ease,
    background-color 120ms ease,
    opacity 120ms ease;
}

.settings-v2-tab:hover {
  opacity: 1;
  color: var(--neutral-100);
  background: var(--brand-surface-bg-hover);
}

.settings-v2-tab:focus-visible {
  outline: 2px solid var(--focus-ring, var(--neutral-50));
  outline-offset: -2px;
}

.settings-v2-tab.is-active {
  opacity: 1;
  color: var(--neutral-100);
  background: var(--neutral-800);
}

.settings-v2-tab-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}

.settings-v2-tab-icon {
  flex-shrink: 0;
  opacity: 0.85;
}

/* Update-available dot, overlapped on the bottom-right of the Update tab
   icon — same corner + chrome as the IPP instance-row dots (running /
   update / op): a small orange dot with a ring in the surface colour so
   it reads as a badge on the icon rather than floating text after the
   label. */
.settings-v2-tab-badge {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status-update, #f59e0b);
  border: 2px solid var(--modal-surface-bg);
  box-sizing: content-box;
}
.settings-v2-tab.is-active .settings-v2-tab-badge {
  border-color: var(--neutral-800);
}

.settings-v2-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px;
  display: flex;
  flex-direction: column;
  position: relative;
  scrollbar-width: none;
}

.settings-v2-body::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.settings-v2-body-root {
  display: flex;
  flex-direction: column;
  gap: inherit;
  flex: 1 1 auto;
}

/* Inner tab-swap wrapper. Mirrors `.settings-v2-body-root`'s flex
 * column so the wrapped `SettingsSectionList` fragment renders as
 * stacked sections exactly as it did before. Width: 100% so the
 * leaving pane's translateX doesn't squeeze. `flex: 1` propagates
 * the body height down to the op-overlay so it can center. */
.settings-v2-tab-pane {
  display: flex;
  flex-direction: column;
  gap: inherit;
  width: 100%;
  flex: 1 1 auto;
}

.empty {
  color: var(--text-muted);
  font-size: var(--takeover-fs-body);
  margin: 0;
}

.empty.error {
  color: var(--danger);
}

/* ── Inline operation overlay ──────────────────────────────────── */
/* The overlay lives inside .settings-v2-tab-pane which is a flex
 * column child of .settings-v2-body-root → .settings-v2-body.
 * `flex: 1 1 auto` makes it stretch to consume all leftover height
 * in the scroll container so `justify-content: center` actually
 * centers — without this the pane is only as tall as its content. */
.op-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 200px;
  padding: 24px;
  text-align: center;
  width: 100%;
  box-sizing: border-box;
}

/* Status icon */
.op-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
}
.op-icon--success { color: var(--brand-success, #27ae60); }
.op-icon--error   { color: var(--brand-error,   #e74c3c); }

/* Title — big, clear action label */
.op-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  line-height: 1.25;
}
.op-title--error { color: var(--brand-error, #e74c3c); }
.op-title--muted { color: var(--text-muted, var(--neutral-100)); }

/* Install name — secondary line under the title */
.op-name {
  font-size: 12px;
  color: var(--text-muted, var(--neutral-100));
  margin: 0;
  line-height: 1.4;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-name--error { color: var(--brand-error, #e74c3c); opacity: 0.8; }

/* Progress bar */
.op-bar-wrap {
  width: 100%;
  max-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 4px;
}
.op-bar-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.op-bar-status {
  font-size: 11px;
  color: var(--text-muted, var(--neutral-100));
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.op-bar-right {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-shrink: 0;
}
.op-speed {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, var(--neutral-100));
  opacity: 0.65;
}
.op-pct {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text);
}
.op-bar-track {
  height: 3px;
  background: var(--chooser-surface-border);
  border-radius: 2px;
  overflow: hidden;
}
.op-bar-fill {
  height: 100%;
  background: var(--brand-accent, #f5c518);
  border-radius: 2px;
  transition: width 300ms ease;
}
.op-bar-fill.is-indeterminate {
  width: 40%;
  animation: op-bar-slide 1.5s ease-in-out infinite;
}
@keyframes op-bar-slide {
  0%   { transform: translateX(-130%); }
  100% { transform: translateX(280%); }
}

/* Countdown under success title */
.op-countdown {
  font-size: 11px;
  color: var(--text-muted, var(--neutral-100));
  opacity: 0.55;
  margin: 0;
}

/* Error / cancelled action row */
.op-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

/* Buttons */
.op-primary-btn {
  height: 32px;
  padding: 0 18px;
  border-radius: 8px;
  border: none;
  background: var(--brand-accent, #f5c518);
  color: #000;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 120ms ease;
}
.op-primary-btn:hover  { opacity: 0.85; }
.op-primary-btn:active { opacity: 0.7; }

.op-ghost-btn {
  height: 28px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--chooser-surface-border);
  background: transparent;
  color: var(--text-muted, var(--neutral-100));
  font-size: 11px;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.op-ghost-btn:hover { color: var(--text); border-color: var(--text-muted); }

/* Fade transition between sections ↔ progress overlay */
.op-overlay-enter-active,
.op-overlay-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.op-overlay-enter-from,
.op-overlay-leave-to {
  opacity: 0;
  transform: translateY(5px);
}

.settings-v2-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--chooser-surface-border);
  background: var(--modal-surface-bg);
}

/* Transient inline status (e.g. "you're up to date"). Sits on the left
   of the footer and fades in/out instead of interrupting with a modal. */
.settings-v2-notice {
  margin-right: auto;
  font-size: 13px;
  line-height: 1.3;
  color: var(--text-muted);
}
.settings-v2-notice-fade-enter-active,
.settings-v2-notice-fade-leave-active {
  transition: opacity 0.3s ease;
}
.settings-v2-notice-fade-enter-from,
.settings-v2-notice-fade-leave-to {
  opacity: 0;
}

/* Pin both footer buttons to the same 32px height as the left
 * footer's "+ New Instance" so the two footer bands stack visually
 * aligned — global `button` rule defaults to ~38px, which would push
 * the right footer taller than the left. */
.settings-v2-relaunch {
  flex: 0 1 auto;
  min-width: 200px;
  height: 32px;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  transition:
    background-color 160ms ease,
    border-color 160ms ease,
    color 160ms ease;
}

/* Pending-restart promotion. Brand yellow takes over the button so
 * the resolution point lights up against the dark modal surface —
 * no extra chrome, no ring, just a hard semantic swap. Same action
 * (still routes through Restart), the colour just says "now is the
 * moment". Dark text required: yellow is too light for white. */
.settings-v2-relaunch.is-pending-restart,
.settings-v2-relaunch.is-pending-restart:hover {
  background: var(--neutral-50);
  border-color: var(--neutral-50);
  color: var(--neutral-950);
}

.settings-v2-more-wrap {
  position: relative;
  display: inline-flex;
}

.settings-v2-more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 14px;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  /* Matches the picker's "+ New Instance" left-footer button so the
   * two footer affordances read as a pair. Tokenised — the 10% white
   * overlay lives in `--chooser-surface-border-hover` (yes, the name
   * is "border" but the value is the canonical 10% white we want
   * here too; no new token needed). */
  background: var(--chooser-surface-border-hover);
  border: none;
  color: var(--neutral-100);
}

.settings-v2-more:hover,
.settings-v2-more:focus-visible {
  background: var(--brand-surface-border-hover);
  color: var(--text);
  outline: none;
}

.settings-v2-more.is-active {
  background: var(--brand-surface-border-hover);
  color: var(--text);
}
</style>
