<script setup lang="ts">
import { computed, onMounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useInstallList } from '../composables/useInstallList'
import { useCloudCapacity } from '../composables/useCloudCapacity'
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

// --- Cluster top offset ---

/** Unfiltered tile count: New Install + Cloud slot are always present. Reads
 *  the raw list, not `visibleInstalls`, so search never shifts the cluster. */
const baseTileCount = computed(() => 2 + nonCloudInstalls.value.length)

const TILES_PER_ROW = 4
const TOP_MAX_PX = 220 // 1-row resting spot (centered hero)
const TOP_MIN_PX = 32 // floor once the grid claims the height
const TOP_STEP_PX = 110 // shed per extra row

/** Top offset for `--cluster-top`: shrinks as rows grow, so the cluster rises
 *  and hands its space to the grid; bottoms out at `TOP_MIN_PX`. */
const clusterTop = computed(() => {
  const rows = Math.ceil(baseTileCount.value / TILES_PER_ROW)
  const px = TOP_MAX_PX - Math.max(0, rows - 1) * TOP_STEP_PX
  return `${Math.max(TOP_MIN_PX, px)}px`
})

/** Freeze a leaving tile's box so it doesn't collapse under `position:
 *  absolute`, letting survivors FLIP into the gap immediately. */
function lockLeavingTileSize(el: Element): void {
  const node = el as HTMLElement
  const grid = node.parentElement
  if (!grid) return
  const rect = node.getBoundingClientRect()
  const gridRect = grid.getBoundingClientRect()
  node.style.width = `${rect.width}px`
  node.style.height = `${rect.height}px`
  node.style.left = `${rect.left - gridRect.left + grid.scrollLeft}px`
  node.style.top = `${rect.top - gridRect.top + grid.scrollTop}px`
}

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

async function pickInstall(inst: Installation): Promise<void> {
  // Cloud capacity gate — catches the case where a cloud install
  // already exists and the user clicks its per-install tile (the
  // generic "Try Cloud" tile gates separately in `handleCloudClick`).
  if (inst.sourceCategory === 'cloud' && !(await cloudCapacity.confirmEntry())) return
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

// Capacity-protection switch (PostHog flag `desktop-cloud-capacity`).
// When `disabled`, the tile is greyed out and the click is a no-op so
// users can't enter cloud during an outage. When `degraded`, the tile
// surfaces a "Heavy usage" meta pill but the click still proceeds.
const cloudCapacity = useCloudCapacity()
/** The capacity tier the tile should render as — collapses raw flag
 *  status with the signed-in tier so a paying user sees a heads-up
 *  chip on `disabled` instead of a "Temporarily unavailable" lockout
 *  they can actually click through. Mirrors what `confirmEntry`
 *  would do on click. */
const dashboardCapacityStatus = computed(() => cloudCapacity.effectiveStatus())

async function handleCloudClick(): Promise<void> {
  // Two paths from the dashboard cloud tile: an existing cloud install
  // (delegate to `pickInstall`, which has its own capacity gate), or
  // promote new-install as a Try-Cloud CTA (no install to pick, so the
  // gate fires here). Calling `confirmEntry` in both branches would
  // double-fire the degraded confirm modal on the existing-install
  // path. The tile is also click-disabled when capacity is `disabled`
  // (free / unknown), so this only really matters for the `degraded`
  // and paid-on-disabled cases.
  if (cloudInstall.value) {
    if (sessionStore.isStopping(cloudInstall.value.id)) return
    void pickInstall(cloudInstall.value)
    return
  }
  if (!(await cloudCapacity.confirmEntry())) return
  emit('show-new-install')
}

function handleNewInstallClick(): void {
  emit('show-new-install')
}
</script>

<template>
  <BrandBackground v-show="props.visible" class="chooser-bg">
    <div class="chooser-view" :style="{ '--cluster-top': clusterTop }">
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

      <TransitionGroup
        v-else
        tag="div"
        name="tile"
        class="chooser-grid"
        @before-leave="lockLeavingTileSize"
      >
        <button
          key="__new"
          type="button"
          class="chooser-tile chooser-tile-new"
          @click="handleNewInstallClick"
        >
          <div class="chooser-tile-icon"><Plus :size="32" /></div>
          <div class="chooser-tile-name">{{ t('chooser.newInstall') }}</div>
          <div class="chooser-tile-meta">{{ t('chooser.newInstallDesc') }}</div>
        </button>

        <div
          v-if="showCloudCard"
          key="__cloud"
          role="button"
          :tabindex="dashboardCapacityStatus === 'disabled' ? -1 : 0"
          :aria-disabled="dashboardCapacityStatus === 'disabled' ? true : undefined"
          class="chooser-tile chooser-tile-cloud"
          :class="{ 'chooser-tile--cloud-disabled': dashboardCapacityStatus === 'disabled' }"
          :data-cloud-capacity="dashboardCapacityStatus"
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
              v-if="dashboardCapacityStatus !== 'normal'"
              class="chooser-tile-pill chooser-tile-pill--capacity"
              :class="{ 'chooser-tile-pill--capacity-disabled': dashboardCapacityStatus === 'disabled' }"
              :title="dashboardCapacityStatus === 'disabled' ? t('cloud.capacityDisabledHint') : t('cloud.capacityDegradedHint')"
            >
              {{ dashboardCapacityStatus === 'disabled' ? t('cloud.capacityDisabled') : t('cloud.capacityDegraded') }}
            </span>
            <span
              v-else
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
      </TransitionGroup>

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

/* `--cluster-top` drives the top spacer (see `clusterTop`). Registered as a
 * <length> so it interpolates — a bare custom property won't transition. */
@property --cluster-top {
  syntax: '<length>';
  inherits: true;
  initial-value: 220px;
}

.chooser-view {
  /* Only the top spacer flexes; wordmark/search/grid stay tight. Shrinking
   * `--cluster-top` raises the cluster and hands height to the grid, which
   * scrolls internally once the bottom spacer (1fr) runs out.
   * Rows: [top spacer] [wordmark] [search] [grid] [bottom spacer] */
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-rows:
    var(--cluster-top)
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
  transition: --cluster-top 260ms cubic-bezier(0.32, 0.72, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  .chooser-view {
    transition-duration: 1ms;
  }
}

.chooser-wordmark {
  grid-row: 2;
  /* `align-self` + `aspect-ratio` keep the SVG from stretching to fill the
   * grid row (default `align-self: stretch` distorts it). */
  align-self: center;
  display: block;
  width: clamp(120px, 8vw, 180px);
  height: auto;
  aspect-ratio: 173 / 48;
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
  /* Containing block for absolutely-positioned leaving tiles (`.tile-leave-active`). */
  position: relative;
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

/* Tile FLIP: enter rises in (ease-out), leave fades out of flow so survivors
 * slide into the gap, move uses the app's iOS-derived curve. Transform/opacity
 * only — GPU-friendly. */
.tile-enter-active {
  transition:
    opacity 200ms ease,
    transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.tile-enter-from {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.tile-leave-active {
  transition:
    opacity 140ms ease,
    transform 140ms cubic-bezier(0.32, 0.72, 0, 1);
  position: absolute;
}
.tile-leave-to {
  opacity: 0;
  transform: scale(0.98);
}

.tile-move {
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  .tile-enter-active,
  .tile-leave-active,
  .tile-move {
    /* Non-zero so Vue's transitionend-driven cleanup still fires and leaving
     * nodes are removed. */
    transition-duration: 1ms;
  }
  .tile-enter-from,
  .tile-leave-to {
    transform: none;
  }
}

</style>
