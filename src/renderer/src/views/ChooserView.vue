<script setup lang="ts">
import { onMounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useInstallList } from '../composables/useInstallList'
import { Cloud, MoreVertical, Plus, Search } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
import BrandBackground from '../components/BrandBackground.vue'
import BaseInput from '../components/ui/BaseInput.vue'
import ComfyWordmark from '../components/icons/ComfyWordmark.vue'
import ChooserInstallTile from './chooser/ChooserInstallTile.vue'
import { resolvePickerTab } from '../lib/pickerTabs'
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
  window.api.openInstancePicker({
    installationId: installation.id,
    initialTab: resolvePickerTab(opts.initialTab, 'status'),
    autoAction: opts.autoAction ?? null
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

        <div
          v-if="showCloudCard"
          role="button"
          tabindex="0"
          class="chooser-tile chooser-tile-cloud"
          @click="handleCloudClick"
          @keydown.enter="handleCloudClick"
          @keydown.space.prevent="handleCloudClick"
          @contextmenu.prevent="cloudInstall ? openCardMenu($event, cloudInstall) : null"
        >
          <div class="chooser-tile-icon"><Cloud :size="32" /></div>
          <!-- Kebab options menu — only when a real cloud install exists to
               manage (parity with the per-install tiles; the Try-Cloud CTA
               has nothing to manage). Keeps the cloud tile consistent with
               the rest of the dashboard pills instead of right-click only. -->
          <div v-if="cloudInstall" class="chooser-tile-actions">
            <button
              type="button"
              class="chooser-tile-kebab"
              :title="t('chooser.moreActions')"
              :aria-label="t('chooser.moreActions')"
              @click.stop="openKebabMenu($event, cloudInstall)"
              @contextmenu.stop="openKebabMenu($event, cloudInstall)"
            >
              <MoreVertical :size="16" />
            </button>
          </div>
          <div class="chooser-tile-name">
            {{ cloudInstall ? cloudInstall.name : t('cloud.label') }}
          </div>
          <div class="chooser-tile-meta">
            <span
              class="chooser-tile-pill"
              :title="cloudInstall ? cloudInstall.sourceLabel : t('cloud.desc')"
            >
              {{ cloudInstall ? cloudInstall.sourceLabel : t('cloud.desc') }}
            </span>
          </div>
        </div>

        <ChooserInstallTile
          v-for="inst in visibleInstalls"
          :key="inst.id"
          :installation="inst"
          :is-stopped-action-gated="isStoppedActionGated(inst)"
          :last-launched-label="lastLaunchedLabel(inst)"
          :has-error="hasError(inst)"
          @pick="pickInstall"
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
  /* Inherit the default justify-content: center from BrandBackground;
   * chooser-view fills the frame and handles its own centering. */
  padding: 0;
}

.chooser-bg :deep(.brand-outer-frame) {
  padding: 0;
  background: transparent;
}

.chooser-bg :deep(.brand-beam--2) {
  left: anchor(center, clamp(39%, calc(52.5vw - 135px), 44%));
}

.chooser-view {
  /* Fluid centering pattern with a top-spacer floor:
   *   - Short grid (initial state, few tiles) → both spacers grow
   *     toward 1fr → cluster centered, as before
   *   - More tiles → spacers shrink symmetrically; top spacer floors
   *     at ~4vh / 24-56px so the wordmark+search keep getting pushed
   *     toward the top of the frame and the grid gains rows in-view
   *   - Very tall grid → grid scrolls internally (max-height 100%)
   *     so the cluster + viewport bounds are never breached
   *
   * Row layout: [top spacer] [wordmark] [search] [grid] [bottom spacer] */
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-rows:
    minmax(clamp(24px, 4vh, 56px), 1fr)
    auto
    auto
    minmax(0, auto)
    minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  justify-items: center;
  width: 100%;
  max-width: 1280px;
  padding: 24px;
  row-gap: 32px;
}

.chooser-wordmark {
  grid-row: 2;
  width: clamp(120px, 8vw, 180px);
  height: auto;
  color: var(--comfy-yellow);
  flex-shrink: 0;
  anchor-name: --brand-beam-target;
}

.chooser-search {
  grid-row: 3;
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
  grid-row: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.6;
  padding: 24px;
}

.chooser-grid {
  grid-row: 4;
  width: 100%;
  /* 4 fixed tracks @ 280px + 3 × 16px gaps = 1168px. Keeps the 280px
   * fixed-track contract from the comment below intact while letting
   * wide viewports surface a 4-up row instead of capping at 3. */
  max-width: 1168px;
  /* When the row collapses (tall grid in a short viewport), the grid
   * stops growing and scrolls internally. `min-height: 0` + an
   * explicit `max-height: 100%` are required so the grid can't push
   * its row past the viewport. */
  min-height: 0;
  max-height: 100%;
  overflow-y: auto;
  display: grid;
  /* Fixed-width tracks instead of `auto-fill` `minmax(...)`: with
   * `auto-fill` the grid reserves blank tracks across the full
   * width, leaving 1-3 cards stuck at the left edge. Fixed-width
   * tracks + `justify-content: center` center the whole row as a
   * group while still wrapping to a new row when room runs out. */
  grid-template-columns: repeat(auto-fit, 280px);
  justify-content: center;
  gap: 16px;
  align-content: start;
  /* Vertical padding pushes the first/last rows into the mask fade
   * so they appear to glide under it rather than clip abruptly. */
  padding: 24px 0;
}

/* Soft top + bottom fade on the scroll viewport so the edge of the
 * grid feels like a smooth dissolve instead of a hard cut. */
@supports (mask-image: linear-gradient(black, black)) {
  .chooser-grid {
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black 32px,
      black calc(100% - 32px),
      transparent 100%
    );
  }
}
</style>
