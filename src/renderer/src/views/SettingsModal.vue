<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownToLine, Box, FolderOpen, Settings as SettingsIcon } from 'lucide-vue-next'
import ModalShell from '../components/ModalShell.vue'
import DetailModal from './DetailModal.vue'
import DirectoriesView from './DirectoriesView.vue'
import DownloadsView from './DownloadsView.vue'
import SettingsView from './SettingsView.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Unified Settings modal — single ModalShell with a left-rail tab
 * switcher hosting the previously-separate panels:
 *   - "ComfyUI Settings" (per-install DetailModal body, embedded)
 *   - "Directories" (combined Models / Media directory browser)
 *   - "Downloads" (rich downloads history — popup deep-links here)
 *   - "Global Settings" (launcher-wide settings — formerly "App Settings")
 *
 * "ComfyUI Settings" is gated on having an installation (install-less
 * host windows have no install backing, so the tab is omitted and
 * the default tab falls through to Global Settings).
 */

export type SettingsTab = 'comfy' | 'directories' | 'downloads' | 'global'

interface Props {
  installation: Installation | null
  initialTab: SettingsTab
  /** Forwarded to the embedded DetailModal as `initialTab` — picks
   *  the inner tab (status / update / snapshots / settings) for the
   *  ComfyUI Settings panel. Optional. */
  initialDetailTab?: string
  /** Forwarded to the embedded DetailModal as `autoAction` — drives
   *  the "auto-run this action on mount" path used by the chooser
   *  card update / migrate pills. Optional. */
  autoAction?: string | null
  /** When true, hide the left-side rail entirely and render only the
   *  active tab's content. Used for chooser-card "Manage…" / Update /
   *  Migrate entry-points where the user picked a specific install
   *  and the cross-install Directories / Global Settings tabs would
   *  be a distraction. The file-menu / title-bar Settings entry
   *  leaves it false so the full sidebar renders. */
  noSidebar?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  initialDetailTab: 'status',
  autoAction: null,
  noSidebar: false,
})

const emit = defineEmits<{
  close: []
  'show-progress': [opts: ShowProgressOpts]
  'navigate-list': []
  'update:installation': [inst: Installation]
}>()

const { t } = useI18n()

const hasInstallation = computed(() => props.installation !== null)

interface TabDef {
  key: SettingsTab
  icon: typeof Box
  label: string
  /** Whether this tab is reachable in the current host context. */
  available: boolean
}

// English fallbacks supplied via `t(key, default)` so the tabs render
// readable labels even while the en locale is missing entries (see
// issue #531). Without these the literal key string ('settingsModal.
// tabDownloads', etc.) leaks into the sidebar and overflows the rail.
const tabs = computed<TabDef[]>(() => [
  {
    key: 'comfy',
    icon: Box,
    label: t('settingsModal.tabComfy', 'ComfyUI Settings'),
    available: hasInstallation.value,
  },
  {
    key: 'directories',
    icon: FolderOpen,
    label: t('settingsModal.tabDirectories', 'Directories'),
    available: true,
  },
  {
    key: 'downloads',
    icon: ArrowDownToLine,
    label: t('settingsModal.tabDownloads', 'Downloads'),
    available: true,
  },
  {
    key: 'global',
    icon: SettingsIcon,
    label: t('settingsModal.tabGlobal', 'Global Settings'),
    available: true,
  },
])

const visibleTabs = computed(() => tabs.value.filter((t) => t.available))

/** Resolve the initial tab against availability: a request for
 *  `comfy` on an install-less host falls through to the default
 *  install-less tab (`global`). */
function resolveInitial(req: SettingsTab): SettingsTab {
  if (req === 'comfy' && !hasInstallation.value) return 'global'
  return req
}

const activeTab = ref<SettingsTab>(resolveInitial(props.initialTab))

// Re-resolve if the host swaps installation underneath us (e.g. the
// install gets deleted while the modal is open) so the active tab
// can never end up referring to a hidden tab.
watch(
  () => [props.initialTab, hasInstallation.value] as const,
  ([req, hasInst]) => {
    if (activeTab.value === 'comfy' && !hasInst) {
      activeTab.value = 'global'
      return
    }
    // If the caller explicitly bumps `initialTab` after mount (rare —
    // overlay swap normally remounts), follow it.
    activeTab.value = resolveInitial(req)
  },
)

// Deep-link override — the title-bar install-update pill (and other
// future deep-link entry-points) opens the overlay with a non-default
// `initialDetailTab` even if the unified Settings modal is already
// mounted. Without this watcher, the inner DetailModal's tab change
// would be invisible because the user was already on Directories or
// Global Settings. Snap the sidebar back to the ComfyUI Settings tab
// whenever a deep-link is present so the detail-tab swap is visible.
watch(
  () => props.initialDetailTab,
  (next, prev) => {
    if (!next || next === prev) return
    if (!hasInstallation.value) return
    activeTab.value = 'comfy'
  },
)

function selectTab(key: SettingsTab): void {
  activeTab.value = key
}

function handleClose(): void {
  emit('close')
}

function handleShowProgress(opts: ShowProgressOpts): void {
  emit('show-progress', opts)
}

function handleNavigateList(): void {
  emit('navigate-list')
}

function handleUpdateInstallation(inst: Installation): void {
  emit('update:installation', inst)
}
</script>

<template>
  <ModalShell :title="t('settingsModal.title', 'Settings')" content-class="settings-modal-shell" @close="handleClose">
    <div class="settings-modal-layout" :class="{ 'no-sidebar': noSidebar }">
      <nav v-if="!noSidebar" class="settings-sidebar" :aria-label="t('settingsModal.title', 'Settings')">
        <button
          v-for="tab in visibleTabs"
          :key="tab.key"
          type="button"
          class="settings-sidebar-item"
          :class="{ active: activeTab === tab.key }"
          @click="selectTab(tab.key)"
        >
          <component :is="tab.icon" :size="18" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>
      <section
        class="settings-content"
        :class="{ 'settings-content-padded': activeTab === 'comfy' }"
      >
        <!-- ComfyUI Settings: DetailModal embedded mode owns its own
             internal layout (title row, tab strip, scrollable body
             via `.view-scroll`, pinned bottom action bar) and was
             designed to sit inside a 20px-padded host (legacy
             `.view-modal-body`) — the bottom action bar's
             `margin: 0 -20px` relies on it for the underline to span
             the full width. We re-apply that 20px gutter here via the
             `settings-content-padded` modifier instead of zeroing it
             out. The column itself stays `overflow: hidden` so the
             embedded `.view-scroll` is the only scroll surface. -->
        <DetailModal
          v-if="activeTab === 'comfy' && installation"
          :installation="installation"
          :initial-tab="initialDetailTab"
          :auto-action="autoAction"
          embedded
          @show-progress="handleShowProgress"
          @navigate-list="handleNavigateList"
          @update:installation="handleUpdateInstallation"
        />
        <!-- Directories / Global Settings render as plain section
             stacks with no internal scroll container, so we wrap each
             in a padded scrollable column here. The wrapper supplies
             the same 20px gutter the legacy `.view-modal-body` did
             plus a vertical scrollbar when the section list overflows. -->
        <div v-else-if="activeTab === 'directories'" class="settings-tab-scroll">
          <DirectoriesView />
        </div>
        <div v-else-if="activeTab === 'downloads'" class="settings-tab-scroll">
          <DownloadsView />
        </div>
        <div v-else-if="activeTab === 'global'" class="settings-tab-scroll">
          <SettingsView />
        </div>
      </section>
    </div>
  </ModalShell>
</template>

<!-- Non-scoped block so we can override the standard `.view-modal-body`
     gutter rendered inside `ModalShell` (`<slot />` content lives one
     scope level up from the body wrapper, so a scoped `:deep()` from
     here can't reliably pierce). We still namespace via
     `.settings-modal-shell` (the `content-class` we pass to
     ModalShell → Modal) so the override only applies to this modal. -->
<style>
.settings-modal-shell > .view-modal-body {
  padding: 0;
}
/* Match GlobalSettingsPanel's transparent-black glass surface during
 * the v2 coexistence window so both Settings entry-points read the
 * same. TODO(brand-cleanup): drop when the legacy SettingsModal is
 * removed. */
.settings-modal-shell {
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
/* Bump the modal's max-width when the sidebar is rendered so the
 * right-hand content area keeps roughly the same effective width as
 * the sidebar-less variant — without this the sidebar's 200px would
 * eat directly into the content column and make Settings feel cramped
 * compared to the chooser-Manage view. We use `:has()` to detect the
 * sidebar's presence so the same modal collapses back to the standard
 * 900px ceiling when ChooserView opens it with `noSidebar`. */
.settings-modal-shell:has(.settings-modal-layout:not(.no-sidebar)) {
  max-width: 1100px;
}
</style>

<style scoped>
.settings-modal-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  height: 100%;
}

.settings-sidebar {
  flex-shrink: 0;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 12px;
  border-right: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  background: var(--bg-elev-1, rgba(127, 127, 127, 0.06));
  overflow-y: auto;
}

.settings-sidebar-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  opacity: 0.85;
  transition: background-color 100ms ease, opacity 100ms ease, border-color 100ms ease;
}

.settings-sidebar-item:hover {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
  opacity: 1;
}

.settings-sidebar-item:focus-visible {
  outline: 2px solid var(--accent, #4a90e2);
  outline-offset: -1px;
}

.settings-sidebar-item.active {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.18));
  border-color: var(--border-strong, rgba(127, 127, 127, 0.4));
  opacity: 1;
  font-weight: 500;
}

.settings-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* The embedded DetailModal owns its own internal scroll region;
   * the Directories / Global Settings tabs delegate scrolling to
   * `.settings-tab-scroll` below. Either way this column stays
   * non-scrolling so the chrome can pin its rows. */
}

/* ComfyUI Settings tab — the embedded DetailModal was designed for
 * a 20px-padded host (matching the legacy `.view-modal-body`), so
 * re-apply that padding only when this tab is active. The bottom
 * action bar's `margin: 0 -20px` rule needs this padding to land
 * the underline edge-to-edge. */
.settings-content-padded {
  padding: 20px;
}

.settings-tab-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px;
}
</style>
