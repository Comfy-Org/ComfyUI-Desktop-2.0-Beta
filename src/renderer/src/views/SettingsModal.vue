<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Box, FolderOpen, Settings as SettingsIcon } from 'lucide-vue-next'
import ModalShell from '../components/ModalShell.vue'
import DetailModal from './DetailModal.vue'
import DirectoriesView from './DirectoriesView.vue'
import SettingsView from './SettingsView.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Unified Settings modal — single ModalShell with a left-rail tab
 * switcher hosting the three previously-separate panels:
 *   - "ComfyUI Settings" (per-install DetailModal body, embedded)
 *   - "Directories" (combined Models / Media directory browser)
 *   - "Global Settings" (launcher-wide settings — formerly "App Settings")
 *
 * "ComfyUI Settings" is gated on having an installation (install-less
 * host windows have no install backing, so the tab is omitted and
 * the default tab falls through to Global Settings).
 */

export type SettingsTab = 'comfy' | 'directories' | 'global'

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
}

const props = withDefaults(defineProps<Props>(), {
  initialDetailTab: 'status',
  autoAction: null,
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

const tabs = computed<TabDef[]>(() => [
  {
    key: 'comfy',
    icon: Box,
    label: t('settingsModal.tabComfy'),
    available: hasInstallation.value,
  },
  {
    key: 'directories',
    icon: FolderOpen,
    label: t('settingsModal.tabDirectories'),
    available: true,
  },
  {
    key: 'global',
    icon: SettingsIcon,
    label: t('settingsModal.tabGlobal'),
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
  <ModalShell :title="t('settingsModal.title')" content-class="settings-modal-shell" @close="handleClose">
    <div class="settings-modal-layout">
      <nav class="settings-sidebar" :aria-label="t('settingsModal.title')">
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
      <section class="settings-content">
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
        <DirectoriesView v-else-if="activeTab === 'directories'" />
        <SettingsView v-else-if="activeTab === 'global'" />
      </section>
    </div>
  </ModalShell>
</template>

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
  /* The embedded DetailModal / DirectoriesView / SettingsView panels
   * own their own internal scroll regions, so this column is the
   * non-scrolling container that gives them height. */
}
</style>
