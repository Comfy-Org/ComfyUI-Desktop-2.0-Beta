<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, X } from 'lucide-vue-next'
import { useComfyUISettings } from '../composables/useComfyUISettings'
import MoreMenu from './comfyUISettings/MoreMenu.vue'
import ArgsBuilderPage from './comfyUISettings/ArgsBuilderPage.vue'
import SnapshotsView from './comfyUISettings/SnapshotsView.vue'
import SettingsSectionList from './comfyUISettings/SettingsSectionList.vue'
import type { ActionDef, DetailField, DetailSection, Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Brand-redesigned Settings drawer (v2). Right-anchored slide-in panel
 * triggered by the title-bar Settings icon. Coexists with the legacy
 * hamburger → `SettingsModal` flow during rollout — legacy modal stays
 * on the `'settings'` panel key, this drawer on `'settings-v2'`.
 *
 * Chrome only: tab strip + scrollable body + pinned footer. All section
 * loading / field updates / action plumbing lives in
 * `useComfyUISettings.ts`. All four tabs render through one section loop
 * — they differ only in the `DetailSection.tab` filter key.
 */

export type ComfyUISettingsTab = 'config' | 'status' | 'update' | 'snapshots'

interface Props {
  open: boolean
  installation: Installation | null
  initialTab?: ComfyUISettingsTab
}

const props = withDefaults(defineProps<Props>(), {
  initialTab: 'config'
})

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
  /** Fired when an action's `result.navigate === 'list'` — the install
   *  was removed (delete / untrack). The host should close this drawer
   *  and tear down the comfy window. Mirrors DetailModal's emit. */
  'navigate-list': []
}>()

const { t } = useI18n()

const activeTab = ref<ComfyUISettingsTab>(props.initialTab)

// Decoupled from `props.open` so we own the leave-animation timing —
// the user-dismiss path (ESC/backdrop/icon) flips `internalOpen` first
// and only emits 'close' on `@after-leave`. An external prop flip
// (e.g. forced close on host teardown / install removal) follows
// synchronously and intentionally skips the animation.
const internalOpen = ref(props.open)

watch(
  () => props.open,
  (next) => {
    internalOpen.value = next
  }
)

watch(
  () => props.initialTab,
  (next) => {
    activeTab.value = next
  }
)

function requestClose(): void {
  // Start the leave animation locally; defer emit until @after-leave.
  internalOpen.value = false
}

// Exposed so the title-bar close path (via panel:request-close-drawer
// IPC) can drive the same animated dismiss as ESC / backdrop.
defineExpose({ requestClose })

function handleAfterLeave(): void {
  emit('close')
}

interface TabDef {
  key: ComfyUISettingsTab
  /** The `DetailSection.tab` literal we filter for. The Figma's "Config"
   *  is sourced from sections tagged `'settings'` (launch-settings
   *  fields built by `buildLaunchSettingsFields` in main). */
  sectionTab: 'settings' | 'status' | 'update' | 'snapshots'
  label: string
}

const tabs = computed<TabDef[]>(() => [
  { key: 'config', sectionTab: 'settings', label: t('comfyUISettings.tabConfig', 'Config') },
  { key: 'status', sectionTab: 'status', label: t('comfyUISettings.tabStatus', 'Status') },
  { key: 'update', sectionTab: 'update', label: t('comfyUISettings.tabUpdate', 'Update') },
  {
    key: 'snapshots',
    sectionTab: 'snapshots',
    label: t('comfyUISettings.tabSnapshots', 'Snapshots')
  }
])

const installation = toRef(props, 'installation')
const {
  loading,
  error,
  updateField,
  runAction,
  sectionsForTab,
  diskUsageItem,
  pinBottomActions,
  reload
} = useComfyUISettings({
  installation,
  onShowProgress: (opts) => emit('show-progress', opts),
  onNavigateList: () => emit('navigate-list'),
  onClose: () => requestClose()
})

const visibleSections = computed(() => {
  const tab = tabs.value.find((tt) => tt.key === activeTab.value)?.sectionTab ?? 'settings'
  const base = sectionsForTab(tab).value
  // Status tab synthesizes one extra readonly row for total disk usage
  // (driven off the same loader the rest of the tab uses). Append it
  // through the shared section list so styling, collapse handling, and
  // readonly chrome stay consistent with every other status row —
  // previously this was a hard-coded `<article>` after the loop.
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

// (Section/field rendering + per-title collapse state now live in
// `SettingsSectionList.vue` — shared with the instance-picker's
// right-pane Settings accordion. Drawer-specific concerns like
// sub-page navigation, focus traps, and A11y handlers stay here.)

// --- A11y + transitions -------------------------------------------------

const drawerRef = useTemplateRef<HTMLElement>('drawer')
let lastFocusedBeforeOpen: HTMLElement | null = null

function handleEsc(event: KeyboardEvent): void {
  if (event.key === 'Escape' && internalOpen.value) {
    event.preventDefault()
    requestClose()
  }
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// `aria-modal="true"` promises tab order is constrained — without this
// trap Tab would leak into the underlying ComfyUI canvas.
function handleTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !internalOpen.value) return
  const root = drawerRef.value
  if (!root) return
  const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement as HTMLElement | null
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function handleTabKeydown(event: KeyboardEvent, index: number): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
  event.preventDefault()
  const delta = event.key === 'ArrowRight' ? 1 : -1
  const next = (index + delta + tabs.value.length) % tabs.value.length
  const nextKey = tabs.value[next]?.key
  if (nextKey) {
    selectTab(nextKey)
    nextTick(() => {
      const buttons = drawerRef.value?.querySelectorAll<HTMLButtonElement>('.settings-v2-tab')
      buttons?.[next]?.focus()
    })
  }
}

async function handleRelaunch(): Promise<void> {
  await window.api.relaunchApp()
}

// Footer "More" dropdown state. Local to the drawer; the menu component
// owns its own outside-click + ESC handlers and emits `close` when the
// user dismisses it that way.
const moreMenuOpen = ref(false)
function toggleMoreMenu(): void {
  moreMenuOpen.value = !moreMenuOpen.value
}
function closeMoreMenu(): void {
  moreMenuOpen.value = false
}

// Close the More menu whenever the drawer closes — leaving it open
// after a slide-out would leave a dangling popover.
watch(internalOpen, (next) => {
  if (!next) moreMenuOpen.value = false
})

// Drawer sub-page state. When set, the drawer body swaps to the
// dedicated sub-page (e.g. the args builder) instead of the tab list.
// Closing the sub-page returns to the tab list; closing the drawer
// also clears the sub-page so re-opening starts fresh.
type SubPage = 'args' | null
const subPage = ref<SubPage>(null)
// Direction of the sub-page transition. Push = forward (slide in from
// right, like iOS/macOS Settings push). Pop = back (slide out to right).
// Tab-switch reset uses 'pop' so the args page slides off-screen as the
// new tab content fades in.
const subPageTransition = ref<'subpage-push' | 'subpage-pop'>('subpage-push')
watch(internalOpen, (next) => {
  if (!next) subPage.value = null
})
function openArgsPage(): void {
  subPageTransition.value = 'subpage-push'
  subPage.value = 'args'
}
function closeSubPage(): void {
  subPageTransition.value = 'subpage-pop'
  subPage.value = null
}

// Tab switch must also dismiss any open sub-page — the args field lives
// in the Config tab, so navigating away should not leave its editor
// orphaned over the new tab's content.
function selectTab(key: ComfyUISettingsTab): void {
  if (subPage.value !== null) subPageTransition.value = 'subpage-pop'
  activeTab.value = key
  subPage.value = null
}

// Active launch-args field, found in the current sections so the sub-
// page can commit changes through the same updateField path.
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

// SnapshotsView emits a typed `run-action` that needs to reach the
// composable's `runAction` (which fires the show-progress flow for
// long-running restore ops).
function handleSnapshotAction(action: ActionDef): void {
  void runAction(action)
}

// Snapshot ops (save / delete / restore-confirmed) ask the host to
// reload sections so any synthetic disk-usage row / pinBottomActions
// stay in sync with the new on-disk state.
function handleSnapshotsRefresh(): void {
  void reload()
}

watch(internalOpen, async (next) => {
  if (next) {
    lastFocusedBeforeOpen = (document.activeElement as HTMLElement | null) ?? null
    activeTab.value = props.initialTab
    await nextTick()
    const firstTab = drawerRef.value?.querySelector<HTMLButtonElement>('.settings-v2-tab.is-active')
    firstTab?.focus()
  } else if (lastFocusedBeforeOpen && document.contains(lastFocusedBeforeOpen)) {
    lastFocusedBeforeOpen.focus()
    lastFocusedBeforeOpen = null
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleEsc)
  document.addEventListener('keydown', handleTab)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleEsc)
  document.removeEventListener('keydown', handleTab)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="settings-drawer-fade" appear>
      <div
        v-if="internalOpen"
        class="settings-v2-backdrop"
        :aria-hidden="true"
        @click="requestClose"
      ></div>
    </Transition>
    <Transition name="settings-drawer-slide" appear @after-leave="handleAfterLeave">
      <aside
        v-if="internalOpen"
        ref="drawer"
        class="settings-v2-drawer"
        role="dialog"
        aria-modal="true"
        :aria-label="t('comfyUISettings.title', 'Settings')"
      >
        <header class="settings-v2-header">
          <h2 class="settings-v2-header-title">
            {{ t('comfyUISettings.title', 'Settings') }}
          </h2>
          <button
            type="button"
            class="settings-v2-header-close"
            :aria-label="t('common.close', 'Close')"
            @click="requestClose"
          >
            <X :size="14" />
          </button>
        </header>

        <nav
          class="settings-v2-tabs"
          role="tablist"
          :aria-label="t('comfyUISettings.title', 'Settings')"
        >
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
            {{
              t('comfyUISettings.emptyInstallLess', 'Open a ComfyUI install to view its settings.')
            }}
          </p>
          <p v-else-if="loading && !visibleSections.length" class="empty">
            {{ t('common.loading', 'Loading…') }}
          </p>
          <p v-else-if="error" class="empty error">{{ error }}</p>

          <!-- Body content with sub-page push/pop transition. The
               transition wraps the sub-page and the tab-content branch
               so navigating into and out of the args editor slides
               horizontally (iOS / macOS Settings convention). -->
          <Transition v-else :name="subPageTransition" mode="out-in">
            <!-- Args sub-page takes over the body when active. Mirror of
               the macOS Settings pattern — narrower than the legacy
               inline editor would fit. -->
            <ArgsBuilderPage
              v-if="subPage === 'args' && installation"
              key="subpage-args"
              :installation-id="installation.id"
              :initial-value="argsValue"
              @back="closeSubPage"
              @update="handleArgsUpdate"
            />

            <div v-else key="subpage-root" class="settings-v2-body-root">
              <!-- Snapshots tab body owns its own list + action flows.
               Long-running restore ops flow via `run-action` → composable's
               runAction → onShowProgress; no separate show-progress emit
               needed on this child. -->
              <SnapshotsView
                v-if="activeTab === 'snapshots' && installation"
                :installation-id="installation.id"
                @run-action="handleSnapshotAction"
                @refresh-all="handleSnapshotsRefresh"
              />

              <!-- Default: section loop for Config / Status / Update tabs.
               Status tab uses a hairline-divider readonly list treatment
               (label-over-value, no input chrome, dividers between rows)
               per Figma — the `readonly` prop on `SettingsSectionList`
               swaps the CSS modifier without forking the template.
               Same component (single source of truth) drives the
               instance-picker's right-pane Settings accordion. -->
              <template v-else>
                <SettingsSectionList
                  :sections="visibleSections"
                  :readonly="activeTab === 'status'"
                  @update-field="updateField"
                  @run-action="runAction"
                  @open-args-page="openArgsPage"
                />
              </template>
            </div>
          </Transition>
        </section>

        <footer class="settings-v2-footer">
          <button type="button" class="primary settings-v2-relaunch" @click="handleRelaunch">
            {{ t('comfyUISettings.relaunch', 'Relaunch') }}
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
              <ChevronDown :size="14" />
            </button>
            <MoreMenu
              :open="moreMenuOpen"
              :actions="pinBottomActions"
              @close="closeMoreMenu"
              @pick="runAction"
            />
          </div>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.settings-v2-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(33, 25, 39, 0.7);
  z-index: 60;
  cursor: pointer;
}

.settings-v2-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 400px;
  max-width: 100vw;
  z-index: 61;
  display: flex;
  flex-direction: column;
  background: var(--neutral-800);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.35);
  color: var(--text);
}

/* Drawer header — Figma: title left + close right, hairline divider
 * separating from the tab strip. */
.settings-v2-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 12px 12px 16px;
  border-bottom: 1px solid var(--border-hover);
  -webkit-app-region: drag;
}

.settings-v2-header-title {
  margin: 0;
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  color: var(--neutral-100);
  letter-spacing: 0;
}

.settings-v2-header-close {
  -webkit-app-region: no-drag;
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--neutral-100);
  border: none;
}

.settings-v2-tabs {
  flex-shrink: 0;
  display: flex;
  gap: 2px;
  padding: 12px 12px 12px;
  border-bottom: 1px solid var(--border-hover);
}

.settings-v2-tab {
  -webkit-app-region: no-drag;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  transition:
    color 120ms ease,
    background-color 120ms ease;
}

.settings-v2-tab:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 4%, transparent);
}

.settings-v2-tab:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.settings-v2-tab.is-active {
  color: var(--neutral-100);
  background: var(--surface);
}

.settings-v2-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Hide horizontal overflow so the sub-page slide does not push the
   * drawer scrollbar during the transition. The transitioning child
   * still gets a full-height column to render into. */
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

/* Wrapper around the tab-content branch so the Transition has a single
 * sibling for `mode="out-in"`. Inherits the body's flex column so the
 * section loop continues to stack as before. */
.settings-v2-body-root {
  display: flex;
  flex-direction: column;
  gap: inherit;
}

.empty {
  color: var(--text-muted);
  font-size: var(--takeover-fs-body);
  margin: 0;
}

.empty.error {
  color: var(--danger);
}

/* Section / field / action styles now colocated with
 * `SettingsSectionList.vue` (the component that renders them) — both
 * the drawer and the instance-picker pick them up via that component's
 * own scoped style block. */

.settings-v2-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-hover);
  background: var(--neutral-800);
}

.settings-v2-relaunch {
  flex: 1;
}

.settings-v2-more-wrap {
  position: relative;
  display: inline-flex;
}

.settings-v2-more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--takeover-fs-body);
}

.settings-v2-more.is-active {
  background: color-mix(in srgb, var(--accent-primary) 14%, var(--surface));
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}
</style>
