<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, X } from 'lucide-vue-next'
import { useComfyUISettings } from '../composables/useComfyUISettings'
import MoreMenu from './comfyUISettings/MoreMenu.vue'
import PathField from './comfyUISettings/PathField.vue'
import EnvVarsField from './comfyUISettings/EnvVarsField.vue'
import ChannelPicker from './comfyUISettings/ChannelPicker.vue'
import ArgsBuilderField from './comfyUISettings/ArgsBuilderField.vue'
import BooleanToggle from './comfyUISettings/BooleanToggle.vue'
import BaseInput from '../components/ui/BaseInput.vue'
import BaseSelect, { type BaseSelectOption } from '../components/ui/BaseSelect.vue'
import ArgsBuilderPage from './comfyUISettings/ArgsBuilderPage.vue'
import SnapshotsView from './comfyUISettings/SnapshotsView.vue'
import InfoTooltip from '../components/InfoTooltip.vue'
import TooltipWrap from '../components/TooltipWrap.vue'
import type { ActionDef, DetailField, Installation, ShowProgressOpts } from '../types/ipc'

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
  return sectionsForTab(tab).value
})

function asString(v: DetailField['value']): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** Per-title collapse state (parity with legacy DetailSection's
 *  `collapsed`). Sections opt into collapsibility by carrying a
 *  `section.collapsed` boolean in their payload; the initial value
 *  pre-seeds the set. Only titled sections are collapsible since the
 *  title is the click target. */
const collapsedTitles = ref(new Set<string>())

watch(
  visibleSections,
  (sections) => {
    for (const s of sections) {
      if (s.title && s.collapsed === true && !collapsedTitles.value.has(s.title)) {
        collapsedTitles.value.add(s.title)
      }
    }
  },
  { immediate: true }
)

function isCollapsible(section: { title?: string; collapsed?: boolean }): boolean {
  return Boolean(section.title) && section.collapsed !== undefined
}

function isCollapsed(section: { title?: string }): boolean {
  return section.title ? collapsedTitles.value.has(section.title) : false
}

function toggleCollapsed(section: { title?: string }): void {
  if (!section.title) return
  if (collapsedTitles.value.has(section.title)) {
    collapsedTitles.value.delete(section.title)
  } else {
    collapsedTitles.value.add(section.title)
  }
}

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
    activeTab.value = nextKey
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
watch(internalOpen, (next) => {
  if (!next) subPage.value = null
})
function openArgsPage(): void {
  subPage.value = 'args'
}
function closeSubPage(): void {
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
            @click="activeTab = tab.key"
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

          <!-- Args sub-page takes over the body when active. Mirror of
               the macOS Settings pattern — narrower than the legacy
               inline editor would fit. -->
          <ArgsBuilderPage
            v-else-if="subPage === 'args' && installation"
            :installation-id="installation.id"
            :initial-value="argsValue"
            @back="closeSubPage"
            @update="handleArgsUpdate"
          />

          <!-- Snapshots tab body owns its own list + action flows.
               Long-running restore ops flow via `run-action` → composable's
               runAction → onShowProgress; no separate show-progress emit
               needed on this child. -->
          <SnapshotsView
            v-else-if="activeTab === 'snapshots' && installation"
            :installation-id="installation.id"
            @run-action="handleSnapshotAction"
            @refresh-all="handleSnapshotsRefresh"
          />

          <!-- Default: section loop for Config / Status / Update tabs.
               Status tab uses a hairline-divider readonly list treatment
               (label-over-value, no input chrome, dividers between rows)
               per Figma. The `.is-readonly-list` modifier swaps the
               section CSS without forking the template. -->
          <template v-else>
            <article
              v-for="(section, si) in visibleSections"
              :key="`s-${si}`"
              class="settings-v2-section"
              :class="{
                'is-readonly-list': activeTab === 'status',
                'is-collapsible': isCollapsible(section),
                'is-collapsed': isCollapsible(section) && isCollapsed(section)
              }"
            >
              <!-- Section title. When collapsible (`section.collapsed`
                   is defined in payload), the title becomes a click
                   target with a chevron that flips on collapse state.
                   Static titles render as a plain header. -->
              <button
                v-if="isCollapsible(section)"
                type="button"
                class="settings-v2-section-title is-toggle"
                :aria-expanded="!isCollapsed(section)"
                @click="toggleCollapsed(section)"
              >
                <ChevronRight
                  :size="14"
                  class="settings-v2-section-chevron"
                  :class="{ 'is-open': !isCollapsed(section) }"
                />
                {{ section.title }}
              </button>

              <p
                v-if="section.description && !isCollapsed(section)"
                class="settings-v2-section-desc"
              >
                {{ section.description }}
              </p>

              <div v-for="(item, i) in section.items" :key="`i-${i}`" class="settings-v2-item">
                <span class="settings-v2-item-label">
                  {{ item.label }}{{ item.active ? ` (${t('common.active', 'active')})` : '' }}
                  <span v-if="item.tag" class="settings-v2-item-tag">{{ item.tag }}</span>
                </span>
                <span v-if="item.actions && item.actions.length" class="settings-v2-item-actions">
                  <TooltipWrap
                    v-for="a in item.actions"
                    :key="a.id"
                    :text="a.enabled === false && a.disabledMessage ? a.disabledMessage : a.tooltip"
                  >
                    <button
                      type="button"
                      :class="[
                        'settings-v2-action',
                        a.style,
                        { 'looks-disabled': a.enabled === false && a.disabledMessage }
                      ]"
                      :disabled="a.enabled === false && !a.disabledMessage"
                      @click="runAction(a)"
                    >
                      {{ a.label }}
                    </button>
                  </TooltipWrap>
                </span>
              </div>

              <div v-for="field in section.fields" :key="field.id" class="settings-v2-field">
                <label class="settings-v2-field-label">
                  {{ field.label }}
                  <InfoTooltip v-if="field.tooltip" :text="field.tooltip" />
                </label>

                <BooleanToggle
                  v-if="field.editType === 'boolean'"
                  :field="field"
                  @update="(v) => updateField(field, v)"
                />

                <BaseSelect
                  v-else-if="field.editType === 'select'"
                  :model-value="asString(field.value)"
                  :options="
                    (field.options ?? []).map(
                      (opt): BaseSelectOption => ({
                        value: opt.value,
                        label: opt.label,
                        description: opt.description
                      })
                    )
                  "
                  :aria-label="field.label"
                  @update:model-value="(v: string) => updateField(field, v)"
                />

                <PathField
                  v-else-if="field.editType === 'path'"
                  :field="field"
                  @update="updateField"
                />

                <ArgsBuilderField
                  v-else-if="field.editType === 'args-builder'"
                  :field="field"
                  @open="openArgsPage"
                  @update="updateField"
                />

                <EnvVarsField
                  v-else-if="field.editType === 'env-vars'"
                  :field="field"
                  @update="updateField"
                />

                <ChannelPicker
                  v-else-if="field.editType === 'channel-cards'"
                  :field="field"
                  @action="runAction"
                />

                <BaseInput
                  v-else-if="field.editType === 'text'"
                  :model-value="asString(field.value)"
                  :aria-label="field.label"
                  @change="(v: string) => updateField(field, v)"
                />

                <span v-else class="settings-v2-field-readonly">{{ asString(field.value) }}</span>
              </div>

              <div v-if="section.actions && section.actions.length" class="settings-v2-actions">
                <TooltipWrap
                  v-for="action in section.actions"
                  :key="action.id"
                  :text="
                    action.enabled === false && action.disabledMessage
                      ? action.disabledMessage
                      : action.tooltip
                  "
                >
                  <button
                    type="button"
                    :class="[
                      'settings-v2-action',
                      {
                        primary: action.style === 'primary',
                        danger: action.style === 'danger',
                        'looks-disabled': action.enabled === false && action.disabledMessage
                      }
                    ]"
                    :disabled="action.enabled === false && !action.disabledMessage"
                    @click="runAction(action)"
                  >
                    {{ action.label }}
                  </button>
                </TooltipWrap>
              </div>
            </article>

            <article
              v-if="activeTab === 'status' && diskUsageItem"
              class="settings-v2-section is-readonly-list"
            >
              <div class="settings-v2-field">
                <label class="settings-v2-field-label">
                  {{ t('comfyUISettings.diskUsage', 'Disk Usage') }}
                </label>
                <span class="settings-v2-field-readonly">{{ diskUsageItem.label }}</span>
              </div>
            </article>
          </template>
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
  background: var(--overlay-bg);
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
  /* Solid surface per Figma — `--titlebar-bg` is `#171718` in dark,
   * which is the same `semantic/base/background` Figma uses for this
   * drawer. Glass/blur was a leftover from earlier iterations; the
   * Figma drawer is opaque. */
  background: var(--titlebar-bg);
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
  padding: 16px;
  display: flex;
  flex-direction: column;
}

.empty {
  color: var(--text-muted);
  font-size: var(--takeover-fs-body);
  margin: 0;
}

.empty.error {
  color: var(--danger);
}

.settings-v2-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.settings-v2-section-title {
  font-size: var(--takeover-fs-body);
  font-weight: 500;
  color: var(--text-muted);
}

.settings-v2-section-title.is-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--text-muted);
  text-align: left;
  align-self: flex-start;
}

.settings-v2-section-title.is-toggle:hover {
  background: transparent;
  color: var(--text);
}

.settings-v2-section-chevron {
  color: var(--text-muted);
  transition: transform 160ms cubic-bezier(0.32, 0.72, 0, 1);
}

.settings-v2-section-chevron.is-open {
  transform: rotate(90deg);
}

/* Collapse the body: hide every direct child of the section EXCEPT
 * the title button (which the user clicks to toggle). Description and
 * the items/fields/actions blocks share this rule so the entire
 * section body disappears in one go. */
.settings-v2-section.is-collapsed > *:not(.settings-v2-section-title) {
  display: none;
}

/* Optional section subtext (parity with legacy DetailSection). */
.settings-v2-section-desc {
  margin: -4px 0 4px;
  font-size: var(--takeover-fs-caption);
  color: var(--text-muted);
  line-height: 1.4;
}

/* Items: label-left + optional inline actions-right. Items with no
 * actions render label-only; the flex layout no-ops on row direction
 * when only one child is present. */
.settings-v2-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--takeover-fs-body);
  color: var(--text);
  line-height: 1.4;
}

.settings-v2-item-label {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* Small pill marker shown next to item labels (e.g. "default",
 * "recommended"). Parity with legacy `item.tag`. */
.settings-v2-item-tag {
  padding: 2px 6px;
  font-size: var(--takeover-fs-caption);
  font-weight: 500;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text) 8%, transparent);
  border-radius: 999px;
}

.settings-v2-item-actions {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.settings-v2-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.settings-v2-field-label {
  display: inline-flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
  color: var(--neutral-100);
  line-height: 19.5px;
}

.settings-v2-field-readonly {
  font-size: 14px;
  color: var(--neutral-100);
  line-height: 21px;
}

.settings-v2-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.settings-v2-action {
  font-size: var(--takeover-fs-body);
}

.settings-v2-actions:has(> .settings-v2-action:only-child) .settings-v2-action {
  flex: 1;
}

.settings-v2-section.is-readonly-list {
  gap: 0;
}

.settings-v2-section.is-readonly-list .settings-v2-field {
  padding: 10px 0;
  border-bottom: 1px solid var(--border-hover);
  gap: 2px;
}

.settings-v2-section.is-readonly-list .settings-v2-field-label {
  color: var(--text-muted);
  font-weight: 400;
}

.settings-v2-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-hover);
  background: var(--titlebar-bg);
}

/* Relaunch consumes global `.primary`. Only override is `flex: 1` to
 * fill the footer width next to the More dropdown. */
.settings-v2-relaunch {
  flex: 1;
}

/* Wrap so the absolutely-positioned MoreMenu anchors to the button. */
.settings-v2-more-wrap {
  position: relative;
  display: inline-flex;
}

/* More button consumes the global button chrome; only adds the inline
 * chevron layout and the active-state accent treatment. */
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
