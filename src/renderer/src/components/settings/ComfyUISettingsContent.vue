<script setup lang="ts">
import { computed, nextTick, ref, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronUp, ArrowLeft } from 'lucide-vue-next'
import { useComfyUISettings } from '../../composables/useComfyUISettings'
import { useSessionStore } from '../../stores/sessionStore'
import MoreMenu from '../../views/comfyUISettings/MoreMenu.vue'
import ArgsBuilderPage from '../../views/comfyUISettings/ArgsBuilderPage.vue'
import SnapshotsView from '../../views/comfyUISettings/SnapshotsView.vue'
import SettingsSectionList from '../../views/comfyUISettings/SettingsSectionList.vue'
import type { PickerTab } from '../../lib/pickerTabs'
import type {
  ActionDef,
  DetailField,
  DetailSection,
  Installation,
  ShowProgressOpts,
} from '../../types/ipc'
import { TID } from '../../../../shared/testIds'

/**
 * Per-install settings body (tab strip + scrollable body + footer).
 * Extracted from `ComfyUISettingsPanel.vue` so the same UI can be hosted
 * by both the drawer chrome and the instance-picker's expanded right
 * pane. The host owns slide-in / popup chrome, focus trap, ESC/Tab and
 * backdrop dismissal; this component is the pure inner UI.
 */

export type ComfyUISettingsTab = PickerTab

interface Props {
  installation: Installation | null
  initialTab?: ComfyUISettingsTab
  /** Render a leading "← Back" affordance in the tab strip. Opt-in
   *  because the drawer host owns its own back-chrome; only the
   *  picker's expanded right pane needs an in-content back. */
  showBack?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'config',
  showBack: false,
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
  /** Leading back affordance click (only rendered when
   *  `showBack === true`). Host decides what "back" means — for the
   *  picker it collapses the expanded mode. */
  back: []
}>()

const { t } = useI18n()

const activeTab = ref<ComfyUISettingsTab>(props.initialTab)

watch(
  () => props.initialTab,
  (next) => {
    activeTab.value = next
  },
)

const installation = toRef(props, 'installation')
const sessionStore = useSessionStore()
const {
  loading,
  error,
  updateField,
  runAction,
  sectionsForTab,
  diskUsageItem,
  pinBottomActions,
  reload,
} = useComfyUISettings({
  installation,
  onShowProgress: (opts) => emit('show-progress', opts),
  onNavigateList: () => emit('navigate-list'),
  onClose: () => emit('request-close'),
})

interface TabDef {
  key: ComfyUISettingsTab
  /** The `DetailSection.tab` literal we filter for. The Figma's "Config"
   *  is sourced from sections tagged `'settings'` (launch-settings
   *  fields built by `buildLaunchSettingsFields` in main). */
  sectionTab: 'settings' | 'status' | 'update' | 'snapshots'
  label: string
}

// Tab visibility is data-driven: a tab is shown iff main emitted at
// least one section for it. Cloud sources don't emit `update` or
// `snapshots` sections (see urlSource.ts), so cloud opens with only
// Config + Status — matching the picker's right-pane visibility rule.
const ALL_TABS: TabDef[] = [
  { key: 'config', sectionTab: 'settings', label: t('comfyUISettings.tabConfig', 'Config') },
  { key: 'status', sectionTab: 'status', label: t('comfyUISettings.tabStatus', 'Status') },
  { key: 'update', sectionTab: 'update', label: t('comfyUISettings.tabUpdate', 'Update') },
  {
    key: 'snapshots',
    sectionTab: 'snapshots',
    label: t('comfyUISettings.tabSnapshots', 'Snapshots'),
  },
]
const tabs = computed<TabDef[]>(() =>
  ALL_TABS.filter((tab) => sectionsForTab(tab.sectionTab).value.length > 0),
)

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
  const base = sectionsForTab(tab).value
  // Status tab synthesizes one extra readonly row for total disk usage
  // (driven off the same loader the rest of the tab uses). Append it
  // through the shared section list so styling, collapse handling, and
  // readonly chrome stay consistent with every other status row.
  if (activeTab.value === 'status' && diskUsageItem.value) {
    return [
      ...base,
      {
        tab: 'status',
        fields: [
          {
            id: '__disk-usage',
            label: t('comfyUISettings.diskUsage', 'Disk Usage'),
            value: diskUsageItem.value.label,
            editable: false,
          },
        ],
      } as DetailSection,
    ]
  }
  return base
})

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
  },
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

const primaryActionLabel = computed(() =>
  isInstallRunning.value
    ? t('instancePicker.restart', 'Restart')
    : t('instancePicker.open', 'Open'),
)

function handlePrimaryAction(): void {
  if (!installation.value) return
  emit('primary-action', isInstallRunning.value)
}

defineExpose({
  /** Host can force-focus the active tab — drawer uses this when it
   *  opens so initial focus lands inside the body. */
  focusActiveTab(): void {
    const firstTab = rootRef.value?.querySelector<HTMLButtonElement>(
      '.settings-v2-tab.is-active',
    )
    firstTab?.focus()
  },
})
</script>

<template>
  <div ref="root" class="settings-v2-content">
    <nav
      class="settings-v2-tabs"
      role="tablist"
      :aria-label="t('comfyUISettings.title', 'Settings')"
    >
      <button
        v-if="showBack"
        type="button"
        class="settings-v2-back"
        :aria-label="t('common.back', 'Back')"
        @click="emit('back')"
      >
        <ArrowLeft :size="14" aria-hidden="true" />
        <span>{{ t('common.back', 'Back') }}</span>
      </button>
      <button
        v-for="(tab, i) in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key"
        :tabindex="activeTab === tab.key ? 0 : -1"
        class="settings-v2-tab"
        :class="{ 'is-active': activeTab === tab.key }"
        @click="selectTab(tab.key)"
        @keydown="handleTabKeydown($event, i)"
      >
        {{ tab.label }}
      </button>
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

        <div v-else key="subpage-root" class="settings-v2-body-root">
          <!-- Inner tab-swap transition. The two child components both
               need to be wrapped in a single-root `<div>` because
               `<Transition>` requires a single root child — and
               `SettingsSectionList` actually renders as a `v-for`
               fragment of `<article>` siblings, which would silently
               disable the animation AND prevent any tab content from
               rendering at all. -->
          <Transition :name="tabTransition" mode="out-in">
            <div
              v-if="activeTab === 'snapshots' && installation"
              key="tab-snapshots"
              class="settings-v2-tab-pane"
            >
              <SnapshotsView
                :installation-id="installation.id"
                @run-action="handleSnapshotAction"
                @refresh-all="handleSnapshotsRefresh"
              />
            </div>
            <div
              v-else
              :key="`tab-${activeTab}`"
              class="settings-v2-tab-pane"
              :data-testid="TID.pickerSettingsSections"
              :data-install-id="installation?.id"
            >
              <SettingsSectionList
                :sections="visibleSections"
                :readonly="activeTab === 'status'"
                :installation-id="installation?.id"
                @update-field="updateField"
                @run-action="runAction"
                @open-args-page="openArgsPage"
              />
            </div>
          </Transition>
        </div>
      </Transition>
    </section>

    <footer class="settings-v2-footer">
      <button
        type="button"
        class="primary settings-v2-relaunch"
        :disabled="!installation"
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
          :disabled="!installation || pinBottomActions.length === 0"
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
}

/* Leading "← Back" affordance (picker expanded mode only — opt-in
 * via the `showBack` prop). Lives inside the tab strip so it sits at
 * the same baseline as the tabs and doesn't fight the tab nav for
 * vertical space. A short vertical rule separates it from the first
 * tab so the click target reads as distinct from the tab list. */
.settings-v2-back {
  -webkit-app-region: no-drag;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 6px 8px;
  margin-right: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--neutral-100);
  font-size: 13px;
  font-weight: 400;
  line-height: 16px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
  position: relative;
}

.settings-v2-back::after {
  content: '';
  position: absolute;
  right: -4px;
  top: 6px;
  bottom: 6px;
  width: 1px;
  background: var(--chooser-surface-border);
}

.settings-v2-back:hover,
.settings-v2-back:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--text);
  outline: none;
}

.settings-v2-tab {
  -webkit-app-region: no-drag;
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
}

/* Inner tab-swap wrapper. Mirrors `.settings-v2-body-root`'s flex
 * column so the wrapped `SettingsSectionList` fragment renders as
 * stacked sections exactly as it did before. Width: 100% so the
 * leaving pane's translateX doesn't squeeze. */
.settings-v2-tab-pane {
  display: flex;
  flex-direction: column;
  gap: inherit;
  width: 100%;
}

.empty {
  color: var(--text-muted);
  font-size: var(--takeover-fs-body);
  margin: 0;
}

.empty.error {
  color: var(--danger);
}

.settings-v2-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--chooser-surface-border);
  background: var(--neutral-800);
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
