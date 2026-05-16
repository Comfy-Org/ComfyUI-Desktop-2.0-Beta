<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, toRef, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import { useGlobalSettings } from '../composables/useGlobalSettings'
import MoreMenu from './globalSettings/MoreMenu.vue'
import PathField from './globalSettings/PathField.vue'
import EnvVarsField from './globalSettings/EnvVarsField.vue'
import ChannelPicker from './globalSettings/ChannelPicker.vue'
import ArgsBuilderField from './globalSettings/ArgsBuilderField.vue'
import ArgsBuilderPage from './globalSettings/ArgsBuilderPage.vue'
import SnapshotsView from './globalSettings/SnapshotsView.vue'
import type { ActionDef, DetailField, Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Brand-redesigned Settings drawer (v2). Right-anchored slide-in panel
 * triggered by the title-bar Settings icon. Coexists with the legacy
 * hamburger → `SettingsModal` flow during rollout — legacy modal stays
 * on the `'settings'` panel key, this drawer on `'settings-v2'`.
 *
 * Chrome only: tab strip + scrollable body + pinned footer. All section
 * loading / field updates / action plumbing lives in
 * `useGlobalSettings.ts`. All four tabs render through one section loop
 * — they differ only in the `DetailSection.tab` filter key.
 */

export type GlobalSettingsTab = 'config' | 'status' | 'update' | 'snapshots'

interface Props {
  open: boolean
  installation: Installation | null
  initialTab?: GlobalSettingsTab
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

const activeTab = ref<GlobalSettingsTab>(props.initialTab)

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
  key: GlobalSettingsTab
  /** The `DetailSection.tab` literal we filter for. The Figma's "Config"
   *  is sourced from sections tagged `'settings'` (launch-settings
   *  fields built by `buildLaunchSettingsFields` in main). */
  sectionTab: 'settings' | 'status' | 'update' | 'snapshots'
  label: string
}

const tabs = computed<TabDef[]>(() => [
  { key: 'config', sectionTab: 'settings', label: t('globalSettings.tabConfig', 'Config') },
  { key: 'status', sectionTab: 'status', label: t('globalSettings.tabStatus', 'Status') },
  { key: 'update', sectionTab: 'update', label: t('globalSettings.tabUpdate', 'Update') },
  {
    key: 'snapshots',
    sectionTab: 'snapshots',
    label: t('globalSettings.tabSnapshots', 'Snapshots')
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
} = useGlobalSettings({
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
        :aria-label="t('globalSettings.title', 'Settings')"
      >
        <nav
          class="settings-v2-tabs"
          role="tablist"
          :aria-label="t('globalSettings.title', 'Settings')"
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
              t('globalSettings.emptyInstallLess', 'Open a ComfyUI install to view its settings.')
            }}
          </p>
          <p v-else-if="loading" class="empty">{{ t('common.loading', 'Loading…') }}</p>
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

          <!-- Default: section loop for Config / Status / Update tabs. -->
          <template v-else>
            <article
              v-for="(section, si) in visibleSections"
              :key="`s-${si}`"
              class="settings-v2-section"
            >
              <header v-if="section.title" class="settings-v2-section-title">
                {{ section.title }}
              </header>

              <div v-for="(item, i) in section.items" :key="`i-${i}`" class="settings-v2-item">
                {{ item.label }}
              </div>

              <div v-for="field in section.fields" :key="field.id" class="settings-v2-field">
                <label class="settings-v2-field-label">{{ field.label }}</label>

                <input
                  v-if="field.editType === 'boolean'"
                  type="checkbox"
                  :checked="field.value === true"
                  @change="updateField(field, ($event.target as HTMLInputElement).checked)"
                />

                <select
                  v-else-if="field.editType === 'select'"
                  :value="asString(field.value)"
                  @change="updateField(field, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="opt in field.options" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>

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

                <input
                  v-else-if="field.editType === 'text'"
                  type="text"
                  :value="asString(field.value)"
                  @change="updateField(field, ($event.target as HTMLInputElement).value)"
                />

                <span v-else class="settings-v2-field-readonly">{{ asString(field.value) }}</span>
              </div>

              <div v-if="section.actions && section.actions.length" class="settings-v2-actions">
                <button
                  v-for="action in section.actions"
                  :key="action.id"
                  type="button"
                  class="settings-v2-action"
                  :class="{
                    'is-primary': action.style === 'primary',
                    'is-danger': action.style === 'danger'
                  }"
                  :disabled="action.enabled === false"
                  @click="runAction(action)"
                >
                  {{ action.label }}
                </button>
              </div>
            </article>

            <article v-if="activeTab === 'status' && diskUsageItem" class="settings-v2-section">
              <div class="settings-v2-item">{{ diskUsageItem.label }}</div>
            </article>
          </template>
        </section>

        <footer class="settings-v2-footer">
          <button type="button" class="primary settings-v2-relaunch" @click="handleRelaunch">
            {{ t('globalSettings.relaunch', 'Relaunch') }}
          </button>
          <div class="settings-v2-more-wrap">
            <button
              type="button"
              class="settings-v2-more"
              data-more-trigger
              :class="{ 'is-active': moreMenuOpen }"
              aria-haspopup="menu"
              :aria-expanded="moreMenuOpen"
              :aria-label="t('globalSettings.more', 'More')"
              :disabled="!installation || pinBottomActions.length === 0"
              @click="toggleMoreMenu"
            >
              {{ t('globalSettings.more', 'More') }}
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
  /* Transparent-black glass surface so the live ComfyUI canvas shows
   * through subtly. `color-mix` keeps us on tokens (no hardcoded
   * alpha-hex) — 80% of `--bg` (dark `#202020` / light `#ffffff`)
   * over transparency. */
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.35);
  color: var(--text);
}

.settings-v2-tabs {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  padding: 12px 16px 0;
  border-bottom: 1px solid var(--border);
}

.settings-v2-tab {
  -webkit-app-region: no-drag;
  padding: 8px 12px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  margin-bottom: -1px;
  transition:
    color 120ms ease,
    border-color 120ms ease;
}

.settings-v2-tab:hover {
  color: var(--text);
}

.settings-v2-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.settings-v2-tab.is-active {
  color: var(--text);
  border-bottom-color: var(--accent);
  font-weight: 500;
}

.settings-v2-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.empty {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0;
}

.empty.error {
  color: var(--danger);
}

.settings-v2-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-v2-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.settings-v2-item {
  font-size: 13px;
  color: var(--text);
}

.settings-v2-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.settings-v2-field-label {
  font-size: 12px;
  color: var(--text-muted);
}

.settings-v2-field input[type='text'],
.settings-v2-field select {
  width: 100%;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}

.settings-v2-field input[type='text']:focus,
.settings-v2-field select:focus {
  outline: none;
  border-color: var(--accent);
}

.settings-v2-field-readonly {
  font-size: 13px;
  color: var(--text-muted);
}

.settings-v2-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}

.settings-v2-action {
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.settings-v2-action:hover:not(:disabled) {
  border-color: var(--border-hover);
}

.settings-v2-action.is-primary {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
  font-weight: 600;
}

.settings-v2-action.is-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.settings-v2-action.is-danger {
  color: var(--danger);
  border-color: var(--danger);
}

.settings-v2-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-v2-footer {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.settings-v2-relaunch {
  flex: 1;
}

/* Wrap so the absolutely-positioned MoreMenu anchors to the button. */
.settings-v2-more-wrap {
  position: relative;
  display: inline-flex;
}

.settings-v2-more {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    border-color 120ms ease;
}

.settings-v2-more:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border-color: var(--border-hover);
}

.settings-v2-more.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border-color: var(--accent);
  color: var(--accent);
}

.settings-v2-more:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  color: var(--text-muted);
}
</style>
