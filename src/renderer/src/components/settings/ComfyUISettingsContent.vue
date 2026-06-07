<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CheckCircle, XCircle, ChevronUp, HardDrive, SlidersHorizontal, Info, RefreshCw, History, SquareTerminal } from 'lucide-vue-next'
import { useComfyUISettings } from '../../composables/useComfyUISettings'
import { useInstallCta } from '../../composables/useInstallCta'
import { useCloudCapacity } from '../../composables/useCloudCapacity'
import { findActionById } from '../../lib/findAction'
import MoreMenu from '../../views/comfyUISettings/MoreMenu.vue'
import ArgsBuilderPage from '../../views/comfyUISettings/ArgsBuilderPage.vue'
import SnapshotsView from '../../views/comfyUISettings/SnapshotsView.vue'
import StatusFactPanel from '../../views/comfyUISettings/StatusFactPanel.vue'
import SettingsSectionList from '../../views/comfyUISettings/SettingsSectionList.vue'
import StoragePane, { type StorageSnapshot } from '../../views/comfyUISettings/StoragePane.vue'
import ConsoleTerminalPane from '../../views/comfyUISettings/ConsoleTerminalPane.vue'
import Tooltip from '../ui/Tooltip.vue'
import type { PickerTab, SectionTab } from '../../lib/pickerTabs'
import { humanizeOpStatus, operationInflightLabel, operationSuccessLabel } from '../../lib/progressStatusLabel'
import type { ActionDef, DetailField, Installation, ShowProgressOpts } from '../../types/ipc'
import { TID } from '../../../../shared/testIds'

/** Per-install settings body. The host owns chrome, focus trap, and
 *  dismissal; this component is the pure inner UI. */

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
  /** Action id to fire automatically once `sections` load. Consumed
   *  once per (autoAction, autoActionNonce) transition. */
  autoAction?: string | null
  /** Bumped on each explicit (re)open. The popup is cached, so keying
   *  the consumed-guard on this nonce lets a repeat trigger re-fire. */
  autoActionNonce?: number
  globalSettingsSnapshot?: StorageSnapshot
  /** When set and the active tab is `'update'`, the Update tab body is
   *  replaced with an inline progress / result view. */
  activeOperation?: ActiveOperation | null
  /** Install attached to the host window. Decides whether the footer
   *  primary action restarts in-place (this window) or focuses the
   *  install's already-open window (another window). */
  activeInstallationId?: string | null
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'update',
  showBack: false,
  autoAction: null,
  autoActionNonce: 0,
  activeOperation: null,
  activeInstallationId: null,
  globalSettingsSnapshot: () => ({
    sharedDirectoriesFields: [],
    modelsDirs: [],
    modelsSystemDefault: '',
  }),
})

const emit = defineEmits<{
  'show-progress': [opts: ShowProgressOpts]
  /** Install was removed; host should close and tear down the window. */
  'navigate-list': []
  'request-close': []
  /** Backend stopped from the preview; host dismisses the whole popup so the
   *  window's stopped-relaunch card shows. */
  'request-dismiss': []
  /** Footer primary CTA. `restartInPlace` is true only when the install
   *  runs in this host window; false when it runs in a different window
   *  so the host routes to `pickInstall` and raises the existing one. */
  'primary-action': [restartInPlace: boolean]
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
const installCta = useInstallCta(installation, {
  activeInstallationId: toRef(props, 'activeInstallationId'),
})
const {
  sections,
  loading,
  error,
  notice,
  sectionsFresh,
  updateField,
  renameInstallation,
  pendingRestartFieldIds,
  clearPendingRestart,
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
  onClose: () => emit('request-close'),
  onDismissPreview: () => emit('request-dismiss')
})

// Fires the named action once per prop transition, after sections load.
// Keyed on `autoAction` + `autoActionNonce` (not install id) so reloads
// on the same trigger don't double-fire while a repeat of the same
// action still re-fires.
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
    () => sectionsFresh.value
  ],
  async ([key, installId, isFresh]) => {
    // `isFresh` guards against acting on a previous install's stale
    // payload — sections are no longer blanked on switch.
    if (!installId || !key || !isFresh) return
    if (consumedAutoActionKey.value === key) return
    const autoAction = props.autoAction
    if (!autoAction) return

    // Channel-card-aware resolution so nested per-channel actions target
    // the install's currently-selected channel, not another channel's
    // same-id action.
    const channelField = sections.value
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.editType === 'channel-cards')
    const currentChannel = typeof channelField?.value === 'string' ? channelField.value : null
    const action = findActionById(sections.value, autoAction, currentChannel)
    if (!action) return

    consumedAutoActionKey.value = key
    await nextTick()

    // Re-check the install after the tick — selection can change and a
    // stale invocation would fire a destructive op against the wrong one.
    if (props.installation?.id !== installId) return

    void runAction(action)
  },
  { immediate: true }
)

// Auto-refresh stale channel-cards when the Update tab opens, so a user
// who opens the picker long after install doesn't see release data from
// the last manual check. Per-(install, channel) dedupe via
// `refreshedChannelKeys`; main short-circuits on a 10s window.
const refreshedChannelKeys = new Set<string>()
watch(
  [() => activeTab.value, () => props.installation?.id ?? null, () => sectionsFresh.value],
  ([tab, installId, isFresh]) => {
    // `isFresh` is critical: without it the watcher would walk the
    // previous install's stale sections and fire `check-update` against
    // the new install, which errors on Cloud / remote URL installs.
    if (tab !== 'update' || !installId || !isFresh) return

    const channelField = sections.value
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.editType === 'channel-cards')
    if (!channelField) return

    const currentChannel = typeof channelField.value === 'string' ? channelField.value : null
    if (!currentChannel) return

    // Look up the canonical action def from sections to inherit whatever
    // `enabled` / disabledMessage main attaches. Bail if main isn't
    // exposing the action for this install.
    const checkAction = sections.value
      .flatMap((s) => s.actions ?? [])
      .find((a) => a.id === 'check-update')
    if (!checkAction || checkAction.enabled === false) return

    const dedupeKey = `${installId}:${currentChannel}`
    if (refreshedChannelKeys.has(dedupeKey)) return
    refreshedChannelKeys.add(dedupeKey)

    // `silent: true` — automatic on-tab-open refresh, not a user click,
    // so it must not pop the "you're up to date" alert a manual check does.
    void runAction({ ...checkAction, data: { ...checkAction.data, silent: true } })
  },
  { immediate: true }
)

interface TabDef {
  key: ComfyUISettingsTab
  sectionTab: SectionTab
  label: string
  icon: typeof SlidersHorizontal
  /** Richer hover copy; falls back to `label` when unset. */
  tooltip?: string
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
    icon: History,
    tooltip: t('tooltips.snapshots')
  },
  {
    key: 'storage',
    sectionTab: 'storage',
    label: t('comfyUISettings.tabStorage', 'Storage'),
    icon: HardDrive
  },
  {
    key: 'console',
    sectionTab: 'console',
    label: t('comfyUISettings.tabConsole', 'Console'),
    icon: SquareTerminal,
    tooltip: t('tooltips.console')
  },
  {
    key: 'status',
    sectionTab: 'status',
    label: t('comfyUISettings.tabStatus', 'About'),
    icon: Info
  }
]

// The console tab has no backend `sections` — it's a live PTY view — so it
// can't be section-gated like the others. Show it for any local install
// (cloud installs run no local process to attach a shell to).
const showConsoleTab = computed(
  () => installation.value != null && installation.value.sourceCategory !== 'cloud'
)

const tabs = computed<TabDef[]>(() => {
  // Cloud runs no local process, so the `config` tab carries no real
  // startup args — relabel it "Storage" to match its contents.
  const isCloud = installation.value?.sourceCategory === 'cloud'
  return ALL_TABS.filter((tab) =>
    tab.key === 'console'
      ? showConsoleTab.value
      : sectionsForTab(tab.sectionTab).value.length > 0
  ).map((tab) =>
    isCloud && tab.key === 'config'
      ? { ...tab, label: t('comfyUISettings.tabStorage', 'Storage'), icon: HardDrive }
      : tab
  )
})

const showUpdateBadge = computed(() => {
  const inst = installation.value
  return inst?.statusTag?.style === 'update' || inst?.status === 'update-available'
})

// If the selected tab disappeared, fall back to the requested
// `initialTab` if now available, else the first surviving tab. Prefer
// the requested tab over `next[0]` so deep links honour caller intent.
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
const tabsRef = useTemplateRef<HTMLElement>('tabs')

// Tooltips that echo the visible label add nothing, so only keep them
// alive for tabs whose label is hidden. Mirror the `< 520px` collapse
// breakpoint (see `@container settings-tabs` below) via a ResizeObserver.
const TAB_COLLAPSE_PX = 520
const tabsCollapsed = ref(false)
let tabsObserver: ResizeObserver | undefined

onMounted(() => {
  if (tabsRef.value && typeof ResizeObserver !== 'undefined') {
    tabsObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      tabsCollapsed.value = entry.contentRect.width < TAB_COLLAPSE_PX
    })
    tabsObserver.observe(tabsRef.value)
  }
})

onUnmounted(() => {
  tabsObserver?.disconnect()
  tabsObserver = undefined
})

function isTabLabelHidden(key: ComfyUISettingsTab): boolean {
  return tabsCollapsed.value && activeTab.value !== key
}

function handleTabKeydown(event: KeyboardEvent, index: number): void {
  if (opInflight.value) return
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

const moreMenuOpen = ref(false)
function toggleMoreMenu(): void {
  moreMenuOpen.value = !moreMenuOpen.value
}
function closeMoreMenu(): void {
  moreMenuOpen.value = false
}

// When set, the body swaps to the dedicated sub-page instead of the
// tab list. Tab switch resets it so the args editor never orphans.
type SubPage = 'args' | null
const subPage = ref<SubPage>(null)
const subPageTransition = ref<'subpage-push' | 'subpage-pop'>('subpage-push')
function openArgsPage(): void {
  subPageTransition.value = 'subpage-push'
  subPage.value = 'args'
}
function closeSubPage(): void {
  subPageTransition.value = 'subpage-pop'
  subPage.value = null
}

// Tab-swap transition direction. Compares tab indices from the visible
// `tabs` list (not static ALL_TABS) because cloud installs hide tabs.
const tabTransition = ref<'subpage-push' | 'subpage-pop'>('subpage-push')

function selectTab(key: ComfyUISettingsTab): void {
  // Locked while an op is in flight — only the active tab stays live.
  if (opInflight.value && key !== activeTab.value) return
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

// Reset sub-page + close the More menu when the install changes, and
// force the tab-swap into "push" so every switch reads as forward motion.
watch(
  () => props.installation?.id ?? null,
  () => {
    subPage.value = null
    moreMenuOpen.value = false
    tabTransition.value = 'subpage-push'
  }
)

// Keys the inner tab panes so switching installs (even on the same tab)
// remounts the pane and fires the `tabTransition` animation.
const paneInstallKey = computed(() => props.installation?.id ?? 'none')

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

/** Live `remoteUrl` field from the status sections (remote connections only). */
const remoteUrlField = computed<DetailField | null>(() => {
  for (const s of sectionsForTab('status').value) {
    for (const f of s.fields ?? []) {
      if (f.id === 'remoteUrl') return f
    }
  }
  return null
})

/** Commit a remote-URL edit through `updateField` (optimistic write, rollback,
 *  error pill, restart-dirty + telemetry). Resolves `false` on rejection so
 *  StatusFactPanel reverts; success is read back from the field-error map. */
async function handleUrlUpdate(value: string): Promise<boolean> {
  const field = remoteUrlField.value
  if (!field) return false
  await updateField(field, value)
  return !fieldErrorMessages.value.has(field.id)
}

function handleSnapshotAction(action: ActionDef): void {
  void runAction(action)
}

function handleSnapshotsRefresh(): void {
  void reload()
}

const isRunningInThisWindow = installCta.runningInThisWindow

const hasPendingRestart = computed(
  () => isRunningInThisWindow.value && pendingRestartFieldIds.value.size > 0
)

// Cloud capacity-protection switch. When cloud capacity is `disabled`,
// disable the CTA so the click visibly goes nowhere (parent already
// no-ops it).
const cloudCapacity = useCloudCapacity()
const isCloudCapacityBlocked = computed(
  () =>
    installation.value?.sourceCategory === 'cloud' &&
    cloudCapacity.effectiveStatus() === 'disabled'
)

const primaryActionLabel = computed(() => {
  if (isCloudCapacityBlocked.value) {
    return t('cloud.capacityDisabled', 'Temporarily unavailable')
  }
  if (hasPendingRestart.value) {
    return t('instancePicker.restartToApply', 'Restart to apply changes')
  }
  return installCta.label.value
})

function handlePrimaryAction(): void {
  const selectedInstall = installation.value
  if (!selectedInstall) return
  // The restart-in-place click IS the restart: main stops + relaunches with the
  // freshly-saved values, so consume the pending-restart state now. A remote
  // relaunch surfaces no observable lifecycle dip, so the watchers can't clear it.
  if (installCta.restartInPlace.value && pendingRestartFieldIds.value.size > 0) {
    clearPendingRestart(selectedInstall.id)
  }
  emit('primary-action', installCta.restartInPlace.value)
}

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

const opTitleLabel = computed(() => {
  const op = props.activeOperation
  return op ? operationInflightLabel(op, t) : ''
})

const opSuccessLabel = computed(() => {
  const op = props.activeOperation
  return op ? operationSuccessLabel(op, t) : ''
})

function formatSpeed(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`
  if (bps >= 1_000)     return `${Math.round(bps / 1_000)} KB/s`
  return `${Math.round(bps)} B/s`
}
const opSpeedLabel = computed(() => {
  const spd = props.activeOperation?.speedBytesPerSec
  return (spd != null && spd > 0) ? formatSpeed(spd) : null
})

// Show overlay whenever an op is present, except snapshot-restore on
// the Snapshots tab, which has its own timeline rail in SnapshotsView.
const showOpOverlay = computed(() => {
  const op = props.activeOperation
  if (!op) return false
  if (op.actionId === 'snapshot-restore' && activeTab.value === 'snapshots') return false
  return true
})

const opBlocksFooter = computed(() => opInflight.value)

// The tab that renders progress for the active op. Only snapshot-restore
// has its own rail in SnapshotsView (matching `showOpOverlay`); every
// other op — including snapshot-save/delete — surfaces in the Update
// tab's inline overlay.
const opHomeTab = computed<ComfyUISettingsTab | null>(() => {
  const op = props.activeOperation
  if (!op) return null
  return op.actionId === 'snapshot-restore' ? 'snapshots' : 'update'
})

// Locking the other tabs during an op is meant to force the user onto
// the progress view, but the lock alone doesn't move them there. Switch
// to the op's home tab whenever the selected install has an in-flight op
// so progress is always visible. Covers op-start, mount, async tab load,
// and selecting an already-operating install (e.g. from another window's
// shelf). Sets `activeTab` directly because `selectTab` is locked mid-op.
watch(
  [
    () => opInflight.value,
    () => props.installation?.id ?? null,
    () => tabs.value.map((tab) => tab.key).join(',')
  ],
  () => {
    if (!opInflight.value) return
    const home = opHomeTab.value
    if (!home || activeTab.value === home) return
    if (!tabs.value.some((tab) => tab.key === home)) return
    activeTab.value = home
  },
  { immediate: true }
)

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
  // Reload so installed version + update badge reflect the new state.
  void reload()
  // Clear the dedup key so the auto-refresh watcher can re-fire.
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

// Close the More menu when an op begins, before its footer button greys out.
watch(opInflight, (yes) => {
  if (yes && moreMenuOpen.value) closeMoreMenu()
})

onUnmounted(clearCountdown)

defineExpose({
  /** Host can force-focus the active tab so initial focus lands in the body. */
  focusActiveTab(): void {
    const firstTab = rootRef.value?.querySelector<HTMLButtonElement>('.settings-v2-tab.is-active')
    firstTab?.focus()
  }
})
</script>

<template>
  <div ref="root" class="settings-v2-content">
    <nav
      ref="tabs"
      class="settings-v2-tabs"
      :class="{ 'is-subpage-active': subPage !== null }"
      role="tablist"
      :aria-label="t('comfyUISettings.title', 'Settings')"
      :aria-hidden="subPage !== null"
    >
      <Tooltip
        v-for="(tab, i) in tabs"
        :key="tab.key"
        :text="tab.tooltip ?? tab.label"
        side="bottom"
        :disabled="tab.tooltip ? false : !isTabLabelHidden(tab.key)"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.key"
          :tabindex="activeTab === tab.key ? 0 : -1"
          :disabled="opInflight && activeTab !== tab.key"
          class="settings-v2-tab"
          :class="{
            'is-active': activeTab === tab.key,
            'is-locked': opInflight && activeTab !== tab.key,
          }"
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
        v-else-if="loading && !visibleSections.length && activeTab !== 'console'"
        class="empty"
        :data-testid="TID.pickerSettingsLoading"
      >
        {{ t('common.loading', 'Loading…') }}
      </p>
      <p v-else-if="error && activeTab !== 'console'" class="empty error">{{ error }}</p>

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
          :class="{ 'is-stale': !sectionsFresh }"
          :data-testid="TID.pickerSettingsSections"
          :data-install-id="installation?.id"
        >
          <!-- Always-visible explanation of why the Start button is
               greyed (the tooltip is hover-only). -->
          <div
            v-if="isCloudCapacityBlocked"
            class="cloud-capacity-banner"
            role="status"
          >
            <Info :size="16" class="cloud-capacity-banner-icon" aria-hidden="true" />
            <div class="cloud-capacity-banner-body">
              <p class="cloud-capacity-banner-title">{{ $t('cloud.capacityDisabled') }}</p>
              <p class="cloud-capacity-banner-hint">{{ $t('cloud.capacityDisabledHint') }}</p>
            </div>
          </div>
          <Transition :name="tabTransition" mode="out-in">
            <div
              v-if="activeTab === 'snapshots' && installation"
              :key="`tab-snapshots-${paneInstallKey}`"
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
              :key="`tab-status-${paneInstallKey}`"
              class="settings-v2-tab-pane"
            >
              <StatusFactPanel
                :installation="installation"
                :sections="statusSections"
                :disk-usage="diskUsageItem"
                :on-rename="renameInstallation"
                :on-update-url="handleUrlUpdate"
                :url-restart-pending="pendingRestartFieldIds.has('remoteUrl')"
              />
            </div>
            <div
              v-else-if="activeTab === 'storage'"
              :key="`tab-storage-${paneInstallKey}`"
              class="settings-v2-tab-pane"
            >
              <!-- Lazy-mounted via `v-else-if` so picker opens that never
                   visit Storage skip rendering the global model-dir UI. -->
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
            <div
              v-else-if="activeTab === 'console' && installation"
              :key="`tab-console-${paneInstallKey}`"
              class="settings-v2-tab-pane settings-v2-tab-pane--console"
            >
              <ConsoleTerminalPane :installation-id="installation.id" />
            </div>
            <div v-else :key="`tab-${activeTab}-${paneInstallKey}`" class="settings-v2-tab-pane">
              <Transition name="op-overlay" mode="out-in">
                <div v-if="showOpOverlay" key="op-overlay" class="op-overlay">

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
        :class="{ 'is-pending-restart': hasPendingRestart, 'is-capacity-disabled': isCloudCapacityBlocked }"
        :disabled="!installation || opBlocksFooter || isCloudCapacityBlocked"
        :title="isCloudCapacityBlocked ? $t('cloud.capacityDisabledHint') : undefined"
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
          :disabled="!installation || pinBottomActions.length === 0 || opInflight || !sectionsFresh"
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

/* Narrow right-pane: inactive tabs collapse to icon-only; the active
   tab keeps its label. */
@container settings-tabs (max-width: 520px) {
  .settings-v2-tab:not(.is-active) {
    padding: 6px 8px;
    gap: 0;
  }
  /* Hide the label but keep the icon wrap (carries the update dot). */
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

/* Locked while an instance op is in flight — only the active tab stays live. */
.settings-v2-tab.is-locked {
  opacity: 0.4;
  cursor: not-allowed;
}

.settings-v2-tab.is-locked:hover {
  opacity: 0.4;
  background: transparent;
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

/* Update-available dot overlapped on the bottom-right of the Update tab icon. */
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

/* During a picker-row switch the previous install's sections stay
 * painted while the new install's IPC is in flight. Block pointer
 * interactions so a click can't act on the stale payload. */
.settings-v2-body-root.is-stale {
  pointer-events: none;
}

/* Inner tab-swap wrapper. Width 100% so the leaving pane's translateX
 * doesn't squeeze; `flex: 1` propagates height so the op-overlay centers. */
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

/* `flex: 1 1 auto` stretches the overlay to consume leftover scroll-
 * container height so `justify-content: center` actually centers. */
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

.op-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 2px;
}
.op-icon--success { color: var(--brand-success, #27ae60); }
.op-icon--error   { color: var(--brand-error,   #e74c3c); }

.op-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
  line-height: 1.25;
}
.op-title--error { color: var(--brand-error, #e74c3c); }
.op-title--muted { color: var(--text-muted, var(--neutral-100)); }

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

.op-countdown {
  font-size: 11px;
  color: var(--text-muted, var(--neutral-100));
  opacity: 0.55;
  margin: 0;
}

.op-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

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

/* Pin footer buttons to 32px to match the left footer's "+ New Instance"
 * (global `button` defaults to ~38px). */
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

/* Pending-restart promotion. Dark text required: yellow is too light for white. */
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
  /* `--chooser-surface-border-hover` is the canonical 10% white (named
   * "border" but reused here intentionally). */
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

/* Always-visible explainer for the disabled state (the title tooltip
 * is hover-only). */
.cloud-capacity-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin: 0 0 12px;
  background: var(--accent-danger-soft, rgba(217, 45, 32, 0.08));
  border: 1px solid var(--accent-danger, #d92d20);
  border-radius: 8px;
  color: var(--text);
}
.cloud-capacity-banner-icon {
  color: var(--accent-danger, #d92d20);
  flex: 0 0 auto;
  margin-top: 2px;
}
.cloud-capacity-banner-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cloud-capacity-banner-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-danger, #d92d20);
}
.cloud-capacity-banner-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-muted);
}
</style>
