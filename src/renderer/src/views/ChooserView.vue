<script setup lang="ts">
import { onMounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useInstallList } from '../composables/useInstallList'
import { Cloud, Plus, Search } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
import BrandBackground from '../components/BrandBackground.vue'
import BaseInput from '../components/ui/BaseInput.vue'
import ComfyWordmark from '../components/icons/ComfyWordmark.vue'
import ChooserInstallTile from './chooser/ChooserInstallTile.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Chooser view — recents grid.
 *
 * A golden-ratio tile grid the user picks from. The install-less host
 * window hosts this as the Comfy tab body when no install backs the
 * entry.
 *
 * Layout:
 *   - Top-left: "New Install" (always present).
 *   - Next: "Cloud" — opens an existing cloud install or routes to
 *     new-install as a Try-Cloud CTA.
 *   - Following: every other install ordered by `lastLaunchedAt` desc,
 *     never-launched at the end.
 *   - Filter chips above the grid narrow by source category.
 *
 * Per-install tile rendering lives in `chooser/ChooserInstallTile.vue`.
 */

const props = withDefaults(
  defineProps<{
    visible?: boolean
  }>(),
  {
    visible: true
  }
)

const emit = defineEmits<{
  /** User picked an install — caller decides whether to swap-in-place,
   *  open a fresh window, or hand off to a launch flow. */
  pick: [installation: Installation]
  /** User triggered the new-install flow (top-left card or empty Cloud
   *  card). */
  'show-new-install': []
  /** A long-running action was kicked off from the inline Manage…
   *  DetailModal. Forwarded to PanelApp so it can wire the operation
   *  through `progressStore`. */
  'show-progress': [opts: ShowProgressOpts]
}>()

const { t } = useI18n()
const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const progressStore = useProgressStore()

onMounted(() => {
  if (installationStore.installations.length === 0) {
    void installationStore.fetchInstallations()
  }
})

// Filter / search / recency / cloud-split logic is shared with the
// title-bar instance picker popover via `useInstallList` so the two
// surfaces cannot drift. The chip UI is currently hidden in the brand
// redesign but the underlying `activeFilter` ref + filter switch stay
// wired; tests reach into `vm.activeFilter` to drive the filter-based
// regressions guard.
//
// "Local" includes both standalone local installs and Legacy Desktop
// installs (`sourceCategory === 'desktop'`) — they're conceptually the
// same family from the user's POV.
const installationsRef = toRef(installationStore, 'installations')
const {
  searchQuery,
  activeFilter,
  cloudInstall,
  nonCloudInstalls,
  visibleInstalls,
  showCloudCard,
  showEmptyHint,
  lastLaunchedLabel
} = useInstallList({ installations: installationsRef })

// Explicitly expose `activeFilter` so the brand-redesign tests can
// drive the underlying filter state without the chip UI mounted.
// `<script setup>` would otherwise auto-hide it because the template
// doesn't reference the ref directly (chips are TODO(brand-cleanup)).
defineExpose({ activeFilter })

// --- Manage / context menu ---
// All Manage routes go through `window.api.openInstancePicker` (the
// picker popup) — the legacy `useOverlay`-driven `ManageInstallModal`
// route is retired.

function openManage(
  installation: Installation,
  opts: { initialTab?: string; autoAction?: string | null } = {}
): void {
  // Every Manage entry — bare "Manage…" and the specialised kebab
  // items (Update / Migrate / Restore Snapshot / Delete) — routes to
  // the instance-picker popup. Bare goes to compact (default identity
  // card + CTAs); specialised paths open the picker directly in
  // expanded mode on the relevant tab with `autoAction` so the action
  // fires on mount of `ComfyUISettingsContent`.
  const hasSpecialisedOpts =
    opts.initialTab !== undefined || (opts.autoAction !== undefined && opts.autoAction !== null)
  if (!hasSpecialisedOpts) {
    window.api.openInstancePicker({ installationId: installation.id })
    return
  }
  const mappedTab =
    opts.initialTab === 'config' || opts.initialTab === 'status'
      || opts.initialTab === 'update' || opts.initialTab === 'snapshots'
      ? opts.initialTab
      : 'status'
  window.api.openInstancePicker({
    installationId: installation.id,
    mode: 'expanded',
    initialTab: mappedTab,
    autoAction: opts.autoAction ?? null,
  })
}

const {
  ctxMenu,
  ctxMenuItems,
  openCardMenu,
  openKebabMenu,
  handleCtxMenuSelect,
  closeMenu,
  triggerAction,
  isStoppedActionGated
} = useInstallContextMenu({
  onManage: (inst, opts) => openManage(inst, opts ?? {}),
  // Fast-path for Delete: forwards to PanelApp so the same ProgressModal
  // pipeline used by every other long op fires here too, without the
  // brief ManageInstallModal flash that the autoAction route produced.
  onShowProgress: (showOpts) => emit('show-progress', showOpts)
})

function hasError(inst: Installation): boolean {
  return sessionStore.errorInstances.has(inst.id)
}

function pickInstall(inst: Installation): void {
  emit('pick', inst)
}

/** Re-open the ProgressModal for the active op on this install — emits
 *  `show-progress` with a no-op `apiCall` so PanelApp's existing-op
 *  branch just re-shows the modal without spawning a duplicate. */
function viewProgress(inst: Installation): void {
  emit('show-progress', {
    installationId: inst.id,
    title: '',
    apiCall: async () => ({})
  })
}

/** Close the install's window AND its underlying process. The window's
 *  main-side `close` handler runs the full teardown, so closeComfyWindow
 *  is enough — no separate stop call needed.
 *
 *  Focus the install window first so a Tier 2 / Tier 3 cancel prompt
 *  (raised by main consulting the panel renderer) is visible — without
 *  this the dashboard window stays in front and the prompt is hidden. */
async function closeRunningInstance(inst: Installation): Promise<void> {
  await window.api.focusComfyWindow(inst.id)
  await window.api.closeComfyWindow(inst.id)
}

function handleCloudClick(): void {
  // If a cloud install exists, route through the same body-click path
  // the install tiles use so behaviour can't drift between the two.
  // Otherwise promote new-install as a Try-Cloud CTA.
  if (cloudInstall.value) {
    if (progressStore.getProgressInfo(cloudInstall.value.id)) {
      viewProgress(cloudInstall.value)
      return
    }
    if (sessionStore.isStopping(cloudInstall.value.id)) return
    pickInstall(cloudInstall.value)
  } else {
    emit('show-new-install')
  }
}

function handleNewInstallClick(): void {
  emit('show-new-install')
}
</script>

<template>
  <BrandBackground v-show="props.visible" class="chooser-bg">
    <div class="chooser-view">
      <ComfyWordmark class="chooser-wordmark" aria-hidden="true" />
      <div class="chooser-search">
        <BaseInput
          v-model="searchQuery"
          :placeholder="t('chooser.searchPlaceholder')"
          :aria-label="t('chooser.searchPlaceholder')"
        >
          <template #leading><Search :size="16" /></template>
        </BaseInput>
      </div>

      <div
        v-if="installationStore.loading && nonCloudInstalls.length === 0"
        class="chooser-loading"
      >
        {{ t('common.loading') }}
      </div>

      <div v-else-if="showEmptyHint" class="chooser-empty">
        {{ t('chooser.noMatches') }}
      </div>

      <div v-else class="chooser-grid">
        <button type="button" class="chooser-tile chooser-tile-new" @click="handleNewInstallClick">
          <div class="chooser-tile-icon"><Plus :size="32" /></div>
          <div class="chooser-tile-name">{{ t('chooser.newInstall') }}</div>
          <div class="chooser-tile-meta">{{ t('chooser.newInstallDesc') }}</div>
        </button>

        <button
          v-if="showCloudCard"
          type="button"
          class="chooser-tile chooser-tile-cloud"
          @click="handleCloudClick"
          @contextmenu.prevent="cloudInstall ? openCardMenu($event, cloudInstall) : null"
        >
          <div class="chooser-tile-icon"><Cloud :size="32" /></div>
          <div class="chooser-tile-name">
            {{ cloudInstall ? cloudInstall.name : t('cloud.label') }}
          </div>
          <div class="chooser-tile-meta">
            <span class="chooser-tile-pill">
              {{ cloudInstall ? cloudInstall.sourceLabel : t('cloud.desc') }}
            </span>
          </div>
        </button>

        <ChooserInstallTile
          v-for="inst in visibleInstalls"
          :key="inst.id"
          :installation="inst"
          :is-stopped-action-gated="isStoppedActionGated(inst)"
          :last-launched-label="lastLaunchedLabel(inst)"
          :has-error="hasError(inst)"
          @pick="pickInstall"
          @show-progress="viewProgress"
          @open-card-menu="openCardMenu"
          @open-kebab-menu="openKebabMenu"
          @trigger-action="(action, installation) => triggerAction(action, installation)"
          @close-running="closeRunningInstance"
        />
      </div>

      <ContextMenu
        :open="ctxMenu.open"
        :x="ctxMenu.x"
        :y="ctxMenu.y"
        :items="ctxMenuItems"
        @close="closeMenu"
        @select="handleCtxMenuSelect"
      />
    </div>
  </BrandBackground>
</template>

<style scoped>
@import './chooser/chooser-tiles.css';

.chooser-bg :deep(.brand-inner-frame) {
  justify-content: flex-start;
  padding: 0;
}

.chooser-bg :deep(.brand-outer-frame) {
  padding: 0;
  background: transparent;
}

.chooser-view {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  max-width: 1080px;
  height: 100%;
  padding: clamp(64px, 31vh, 200px) 24px 24px;
  gap: var(--takeover-gap-lg);
}

.chooser-wordmark {
  width: clamp(120px, 8vw, 180px);
  height: auto;
  color: var(--comfy-yellow);
  flex-shrink: 0;
  margin-bottom: var(--takeover-gap-sm);
}

.chooser-search {
  display: flex;
  justify-content: center;
  width: 100%;
  flex-shrink: 0;
}

.chooser-search :deep(.ui-input) {
  max-width: 600px;
  border-radius: 12px;
  border: 1px solid var(--chooser-surface-border);
  background: var(--chooser-surface-bg);
  padding: 8px;
}

.chooser-search :deep(.ui-input-control) {
  font-size: 14px;
  padding-top: 0;
}

.chooser-loading,
.chooser-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.6;
  padding: 24px;
}

.chooser-grid {
  width: 100%;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  align-content: start;
  padding: 16px 0 8px 0;
}

@supports (mask-image: linear-gradient(black, black)) {
  .chooser-grid {
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 24px,
      black calc(100% - 24px),
      transparent 100%
    );
  }
}
</style>
