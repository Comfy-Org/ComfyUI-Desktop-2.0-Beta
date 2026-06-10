<script setup lang="ts">
import { computed, onMounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useInstallList } from '../composables/useInstallList'
import { useCloudCapacity } from '../composables/useCloudCapacity'
import { useModal } from '../composables/useModal'
import { Plus, Search } from 'lucide-vue-next'
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
 *   - Following: every install (local / cloud / remote) ordered by
 *     `lastLaunchedAt` desc, never-launched at the end.
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
const modal = useModal()

onMounted(() => {
  if (installationStore.installations.length === 0) {
    void installationStore.fetchInstallations()
  }
})

// Filter / search / recency logic is shared with the title-bar
// instance picker popover via `useInstallList` so the two surfaces
// cannot drift. The chip UI is currently hidden in the brand redesign
// but the underlying `activeFilter` ref + filter switch stay wired;
// tests reach into `vm.activeFilter` to drive the filter-based
// regressions guard.
//
// "Local" includes both standalone local installs and Legacy Desktop
// installs (both report `sourceCategory === 'local'`) — they're
// conceptually the same family from the user's POV. Cloud installs
// flow through `visibleInstalls` like every other source — there is no
// special cloud surface anymore.
const installationsRef = toRef(installationStore, 'installations')
const {
  searchQuery,
  activeFilter,
  visibleInstalls,
  showEmptyHint,
  lastLaunchedLabel
} = useInstallList({ installations: installationsRef })

// Explicitly expose `activeFilter` so the brand-redesign tests can
// drive the underlying filter state without the chip UI mounted.
// `<script setup>` would otherwise auto-hide it because the template
// doesn't reference the ref directly (chips are TODO(brand-cleanup)).
defineExpose({ activeFilter })

// --- Cluster top offset ---

/** Unfiltered tile count: New Install + every install (cloud included).
 *  Reads the raw list, not `visibleInstalls`, so search never shifts the
 *  cluster. */
const baseTileCount = computed(
  () => 1 + installationStore.installations.length
)

const TILES_PER_ROW = 4

/** Unfiltered tile rows. Drives the grid's reserved `min-height` so the box
 *  doesn't shrink while filtering — that's what keeps the centered cluster
 *  from shifting when the user types in search. */
const clusterRows = computed(() => Math.ceil(baseTileCount.value / TILES_PER_ROW))

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

async function pickInstall(inst: Installation): Promise<void> {
  // The instance window owns lifecycle. If a host window already exists for
  // this install — running, launching, OR crashed (the window stays open on
  // its lifecycle/error surface) — bring it forward instead of kicking off a
  // second launch with a dashboard takeover. Restart, stop, and crash details
  // all live inside that window.
  if (
    sessionStore.isRunning(inst.id) ||
    sessionStore.isLaunching(inst.id) ||
    sessionStore.errorInstances.has(inst.id)
  ) {
    const focused = await window.api.focusComfyWindow(inst.id)
    // `errorInstances` can be hydrated from the retained crash buffer after
    // the window was closed, so a focus may find nothing — fall through and
    // launch normally in that case.
    if (focused) return
  }
  // Cloud capacity gate — catches the case where a cloud install
  // already exists and the user clicks its per-install tile (the
  // generic "Try Cloud" tile gates separately in `handleCloudClick`).
  if (inst.sourceCategory === 'cloud' && !(await cloudCapacity.confirmEntry())) return
  emit('pick', inst)
}

/** Surface a failed install's error so it's readable from the dashboard.
 *  Covers both op failures (which carry a `message`, e.g. a migrate that
 *  silently did nothing but turn the tile red) and crashes (exit code /
 *  signal + captured stderr). */
function viewError(inst: Installation): void {
  const err = sessionStore.errorInstances.get(inst.id)
  if (!err) return
  let message = err.message
  if (!message) {
    if (err.signal && err.exitCode != null) {
      message = t('comfyLifecycle.crashedDescWithCodeAndSignal', {
        code: err.exitCode,
        signal: err.signal
      })
    } else if (err.signal) {
      message = t('comfyLifecycle.crashedDescWithSignal', { signal: err.signal })
    } else if (err.exitCode != null) {
      message = t('comfyLifecycle.crashedDescWithCode', { code: err.exitCode })
    } else {
      message = t('comfyLifecycle.crashedDesc')
    }
  }
  if (err.lastStderr) message = `${message}\n\n${err.lastStderr}`
  void modal.alert({ title: t('chooser.errorTitle'), message })
}

// Capacity-protection switch (PostHog flag `desktop-cloud-capacity`).
// When `disabled`, the tile is greyed out and the click is a no-op so
// users can't enter cloud during an outage. When `degraded`, the tile
// surfaces a "Heavy usage" meta pill but the click still proceeds.
const cloudCapacity = useCloudCapacity()
function handleNewInstallClick(): void {
  emit('show-new-install')
}
</script>

<template>
  <BrandBackground v-show="props.visible" class="chooser-bg">
    <div class="chooser-view" :style="{ '--rows': clusterRows }">
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
        v-if="installationStore.loading && installationStore.installations.length === 0"
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

        <ChooserInstallTile
          v-for="inst in visibleInstalls"
          :key="inst.id"
          :installation="inst"
          :is-stopped-action-gated="isStoppedActionGated(inst)"
          :last-launched-label="lastLaunchedLabel(inst)"
          @pick="pickInstall"
          @open-card-menu="openCardMenu"
          @open-kebab-menu="openKebabMenu"
          @trigger-action="(action, installation) => triggerAction(action, installation)"
          @view-error="viewError"
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

/* Unitless tile-row count from JS (see `clusterRows`). Registered as <integer>
 * so it's a typed number usable in the grid's reserved-height calc() below. */
@property --rows {
  syntax: '<integer>';
  inherits: true;
  initial-value: 1;
}

.chooser-view {
  /* Symmetric top + bottom spacers (both 1fr) center the wordmark→grid block
   * as a group whenever it fits — looks deliberate at any viewport height.
   * When the (unfiltered) content is taller than the viewport, the
   * `minmax(0, 1fr)` spacers collapse to 0 and the grid scrolls internally.
   * Rows: [top spacer] [wordmark] [search] [grid] [bottom spacer]
   *
   * No-shift guarantee: the grid row reserves its height from the UNFILTERED
   * `--rows` (see `.chooser-grid` min-height), so typing in search empties
   * tiles without shrinking the grid box — the centered cluster stays put. */
  --chooser-pad-y: clamp(12px, 2.5vh, 24px);
  --chooser-row-gap: clamp(16px, 3.5vh, 32px);
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-rows:
    minmax(0, 1fr)
    auto
    auto
    minmax(0, auto)
    minmax(0, 1fr);
  grid-template-columns: minmax(0, 1fr);
  justify-items: center;
  width: 100%;
  max-width: 1280px;
  padding: var(--chooser-pad-y) 24px;
  row-gap: var(--chooser-row-gap);
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
  /* Reserve height for the UNFILTERED row count so the grid box doesn't
   * shrink while typing in search — that's what keeps the centered cluster
   * from jumping (replaces the old top-anchor no-shift trick). One tile is
   * 280px × 280·156.678/246 ≈ 178px tall; rows are 178px + a 16px gap each.
   * `max-height: 100%` still caps it on short viewports, where the grid
   * scrolls internally and the 1fr spacers collapse to 0. */
  --tile-h: 178px;
  min-height: min(
    100%,
    calc(var(--rows) * var(--tile-h) + max(0, var(--rows) - 1) * 16px + 2 * var(--chooser-fade))
  );
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
  /* Vertical padding pushes the first/last rows into the mask fade so they
   * glide under it rather than clip abruptly. Fluid on height (`--chooser-fade`)
   * so short viewports reclaim the band for an extra tile row. */
  --chooser-fade: clamp(12px, 2.5vh, 24px);
  padding: var(--chooser-fade) 0;
}

/* Soft top + bottom fade on the scroll viewport so the edge of the
 * grid feels like a smooth dissolve instead of a hard cut. Fade distance
 * tracks the grid's vertical padding so the first/last rows still tuck under. */
@supports (mask-image: linear-gradient(black, black)) {
  .chooser-grid {
    mask-image: linear-gradient(
      to bottom,
      transparent 0,
      black var(--chooser-fade),
      black calc(100% - var(--chooser-fade)),
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
