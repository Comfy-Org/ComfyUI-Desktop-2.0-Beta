<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { Cloud, Plus, Box, Monitor, Globe, Pin, AlertCircle, ArrowDownToLine, ArrowRightLeft, MoreVertical } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
import DetailModal from './DetailModal.vue'
import type { Installation } from '../types/ipc'

/**
 * Chooser view (Phase 3 step 2 — recents grid).
 *
 * Replaces the standalone Dashboard + Installs + Running surfaces with a
 * single golden-ratio "tile" grid the user picks from. Renderer-only —
 * the install-less host window (Phase 3 step 2c) hosts this as the
 * Comfy tab body when no install backs the entry.
 *
 * Grid layout per the design discussion:
 *   - Top-left card: "New Install" (always present, fixed-position).
 *   - Next card: "Cloud" — opens an existing cloud install if there is
 *     one, otherwise routes to the new-install flow as a Try-Cloud CTA.
 *   - Following cards: every other install (local / desktop / remote)
 *     ordered by `lastLaunchedAt` desc, never-launched at the end.
 *   - Filter chips above the grid let the user narrow by source category.
 *   - Each card carries a type icon (cloud / local / desktop / remote)
 *     so the source kind is visible at a glance.
 *
 * Cards are golden-ratio rectangles (1.618 : 1) and we explicitly do
 * NOT support reordering — the lastLaunchedAt order is the order.
 */

const props = withDefaults(defineProps<{
  visible?: boolean
}>(), {
  visible: true,
})

const emit = defineEmits<{
  /** User picked an install — caller decides whether to swap-in-place,
   *  open a fresh window, or hand off to a launch flow. */
  pick: [installation: Installation]
  /** User triggered the new-install flow (top-left card or empty Cloud
   *  card). */
  'show-new-install': []
  /** A long-running action was kicked off from the inline Manage…
   *  DetailModal (Update, Restore Snapshot, Migrate, …). The host
   *  (`PanelApp`) owns the ProgressModal overlay; we just forward
   *  the event so it can wire the operation through `progressStore`. */
  'show-progress': [opts: {
    installationId: string
    title: string
    apiCall: () => Promise<unknown>
    cancellable?: boolean
    returnTo?: string
  }]
}>()

const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const progressStore = useProgressStore()
const prefs = useLauncherPrefs()

onMounted(() => {
  if (installationStore.installations.length === 0) {
    void installationStore.fetchInstallations()
  }
})

// --- Filter chips ---
type FilterKey = 'all' | 'local' | 'desktop' | 'cloud' | 'remote'
const activeFilter = ref<FilterKey>('all')

interface FilterChip { key: FilterKey; labelKey: string }
const filterChips: FilterChip[] = [
  { key: 'all', labelKey: 'chooser.filterAll' },
  { key: 'local', labelKey: 'chooser.filterLocal' },
  { key: 'desktop', labelKey: 'chooser.filterDesktop' },
  { key: 'cloud', labelKey: 'chooser.filterCloud' },
  { key: 'remote', labelKey: 'chooser.filterRemote' },
]

// --- Cloud card sources its install (if any) from the store ---
const cloudInstall = computed<Installation | null>(() =>
  installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null
)

/** Non-cloud installs — feed the "rest of the grid" after New Install + Cloud. */
const nonCloudInstalls = computed<Installation[]>(() =>
  installationStore.installations.filter((i) => i.sourceCategory !== 'cloud')
)

/** Sort key: lastLaunchedAt desc, never-launched (no timestamp) at the end. */
function sortByRecency(a: Installation, b: Installation): number {
  const ta = typeof a.lastLaunchedAt === 'number' ? a.lastLaunchedAt : -Infinity
  const tb = typeof b.lastLaunchedAt === 'number' ? b.lastLaunchedAt : -Infinity
  return tb - ta
}

/** Sort key: pinned installs first (recency-ordered within pinned), then
 *  unpinned installs (recency-ordered). The pin affordance promotes
 *  installs the user wants to keep visible regardless of how recently
 *  they were launched — the chooser's "Pin" context-menu item drives
 *  this ranking. */
function sortByPinAndRecency(a: Installation, b: Installation): number {
  const aPinned = prefs.isPinned(a.id) ? 1 : 0
  const bPinned = prefs.isPinned(b.id) ? 1 : 0
  if (aPinned !== bPinned) return bPinned - aPinned
  return sortByRecency(a, b)
}

/** Apply the active filter to the non-cloud list. */
const visibleInstalls = computed<Installation[]>(() => {
  const sorted = [...nonCloudInstalls.value].sort(sortByPinAndRecency)
  switch (activeFilter.value) {
    case 'all': return sorted
    case 'local': return sorted.filter((i) => i.sourceCategory === 'local')
    case 'desktop': return sorted.filter((i) => i.sourceCategory === 'desktop')
    case 'remote': return sorted.filter((i) => i.sourceCategory === 'remote')
    case 'cloud': return [] // cloud installs only appear in the Cloud tile
    default: return sorted
  }
})

/** Cloud tile is hidden by the Cloud filter only when there's no cloud
 *  install to show (the Try-Cloud CTA shouldn't survive a filter). */
const showCloudCard = computed(() =>
  activeFilter.value === 'all' || activeFilter.value === 'cloud'
)

/** New Install card is always visible across filters — it's the entry-
 *  point for adding any source category. */
const showNewInstallCard = true

// --- Relative-time formatting (shared with DashboardView's pattern) ---
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  nowTimer = setInterval(() => { now.value = Date.now() }, 60_000)
})
onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer)
})

function timeAgo(timestamp: number): string {
  const diff = now.value - timestamp
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// --- Type icon mapping — visible on each card so source kind is obvious ---
function iconFor(category: string | undefined): typeof Cloud {
  switch (category) {
    case 'cloud': return Cloud
    case 'desktop': return Monitor
    case 'remote': return Globe
    case 'local':
    default: return Box
  }
}

// --- Action / context menu (Pin / Manage / Dismiss error) ---
// The same composable powers two surfaces:
//   - Right-click on a card → context menu at click coords.
//   - Click on the kebab (⋮) button at the top-right of a card →
//     dropdown anchored to the button.
// Both menus carry the same items: Pin / Unpin, Manage… (opens the
// install's DetailModal as an overlay), and Dismiss error (when set).
// The card body's bare click goes through `pickInstall` — the fast-
// path for "open this install" — and the kebab `stopPropagation`s so
// it doesn't double-fire as a card click.
const manageInstall = ref<Installation | null>(null)
const {
  ctxMenu,
  ctxMenuItems,
  openCardMenu,
  openKebabMenu,
  handleCtxMenuSelect,
  closeMenu,
} = useInstallContextMenu({
  onManage: (inst) => { manageInstall.value = inst },
})

function closeManageModal(): void {
  manageInstall.value = null
}

/** DetailModal `update:installation` event — the user edited the
 *  install (renamed it, changed its launch settings, etc.). Splice
 *  the new record in place so the modal and the underlying card stay
 *  in sync without round-tripping through `getInstallations`. Mirrors
 *  the pattern PanelApp uses for the inline DetailModal. */
function handleManageUpdate(inst: Installation): void {
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
  manageInstall.value = inst
}

/** DetailModal `navigate-list` event — the install was deleted /
 *  migrated. Close the modal so the user is returned to the chooser
 *  grid; the installationsChanged broadcast already updated the store
 *  so the deleted card has dropped out of `visibleInstalls`. */
function handleManageNavigateList(): void {
  manageInstall.value = null
}

// --- Card status classes (running, stopping, in-progress, errored) ---
function statusClasses(inst: Installation): Record<string, boolean> {
  return {
    'chooser-tile-running':
      sessionStore.isRunning(inst.id) && !sessionStore.isStopping(inst.id),
    'chooser-tile-stopping': sessionStore.isStopping(inst.id),
    'chooser-tile-in-progress':
      sessionStore.activeSessions.has(inst.id) && !sessionStore.isRunning(inst.id),
    'chooser-tile-errored': hasError(inst),
  }
}

/** Whether the install's last session crashed or its last action errored.
 *  Drives both the card-level red border (statusClasses) and the
 *  AlertCircle badge in the top-right corner — surfaces card-level
 *  visibility for an error state that previously only lived inside the
 *  legacy DetailModal / Running view. */
function hasError(inst: Installation): boolean {
  return sessionStore.errorInstances.has(inst.id)
}

/** Whether the install's source has reported an update-available status
 *  tag. Driven by the same release-cache + channel logic that powers
 *  the Install Settings update banner — main builds `statusTag` for the
 *  install via `source.getStatusTag()` and ships it on every fetch.
 *  We treat any tag with `style: 'update'` as "newer release out there",
 *  surfaced here as a card-level "Update" pill so users notice without
 *  drilling into Install Settings. */
function hasUpdate(inst: Installation): boolean {
  return inst.statusTag?.style === 'update'
}

/** Whether the install is a Legacy Desktop (1.0) install with a pending
 *  migrate-to-standalone action. Today this is purely a `sourceCategory`
 *  check — the desktop source plugin always exposes the migrate action
 *  for installed Desktop 1.0 records (`src/main/sources/desktop.ts`).
 *  Surfacing it here as a "Migrate" pill on the chooser tile lets users
 *  notice the migration prompt without opening Install Settings; the
 *  actual migration UI still lives behind the install-settings panel. */
function hasMigratePrompt(inst: Installation): boolean {
  return inst.sourceCategory === 'desktop' && inst.status === 'installed'
}

/** Active in-flight operation (install / update / restore / migrate) for
 *  this install, surfaced from the renderer-side progressStore. The same
 *  data drives ProgressModal — here we render a thin progress bar +
 *  status line at the bottom of the card so users notice in-progress
 *  work without drilling into the install. Returns null when nothing is
 *  in flight. */
function progressFor(inst: Installation): { status: string; percent: number } | null {
  return progressStore.getProgressInfo(inst.id)
}

function pickInstall(inst: Installation): void {
  emit('pick', inst)
}

function handleCloudClick(): void {
  // If there's an existing cloud install, pick it. Otherwise promote the
  // new-install flow as a Try-Cloud CTA — the renderer-side handler will
  // route to the correct screen once the new-install flow lives in the
  // host window (step 5+ of the unified-window plan).
  if (cloudInstall.value) {
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
  <div v-show="props.visible" class="chooser-view">
    <!-- Filter chips: narrow the grid by source category. The New Install
         and Cloud tiles stay visible regardless (they're entry-points,
         not data rows), per the design — except the Cloud tile is hidden
         when filtering to local/desktop/remote where it would be noise. -->
    <div class="chooser-filters">
      <button
        v-for="chip in filterChips"
        :key="chip.key"
        type="button"
        class="chooser-filter-chip"
        :class="{ active: activeFilter === chip.key }"
        @click="activeFilter = chip.key"
      >
        {{ $t(chip.labelKey) }}
      </button>
    </div>

    <!-- Loading state — chooser-grid scrolls; the loading message replaces it. -->
    <div
      v-if="installationStore.loading && nonCloudInstalls.length === 0"
      class="chooser-loading"
    >
      {{ $t('common.loading') }}
    </div>

    <!-- Golden-ratio grid: New Install + Cloud + every install. -->
    <div v-else class="chooser-grid">
      <!-- New Install card (top-left, fixed) -->
      <button
        v-if="showNewInstallCard"
        type="button"
        class="chooser-tile chooser-tile-new"
        @click="handleNewInstallClick"
      >
        <div class="chooser-tile-icon"><Plus :size="32" /></div>
        <div class="chooser-tile-name">{{ $t('chooser.newInstall') }}</div>
        <div class="chooser-tile-meta">{{ $t('chooser.newInstallDesc') }}</div>
      </button>

      <!-- Cloud card (next, fixed when an existing install or as Try-Cloud CTA) -->
      <button
        v-if="showCloudCard"
        type="button"
        class="chooser-tile chooser-tile-cloud"
        @click="handleCloudClick"
        @contextmenu.prevent="cloudInstall ? openCardMenu($event, cloudInstall) : null"
      >
        <div class="chooser-tile-icon"><Cloud :size="32" /></div>
        <div class="chooser-tile-name">
          {{ cloudInstall ? cloudInstall.name : $t('cloud.label') }}
        </div>
        <div class="chooser-tile-meta">
          <span class="chooser-tile-pill">
            {{ cloudInstall ? cloudInstall.sourceLabel : $t('cloud.desc') }}
          </span>
        </div>
      </button>

      <!-- Install tiles (recents-ordered).
           Click on the tile body → fast-path open (the most common
           gesture). The kebab (⋮) icon at the top-right surfaces
           Pin / Manage / Dismiss in a dropdown menu — its click
           stops propagation so it doesn't double-fire as a card
           click. Right-click on the tile opens the same menu at
           pointer coordinates as a power-user gesture. -->
      <button
        v-for="inst in visibleInstalls"
        :key="inst.id"
        type="button"
        class="chooser-tile"
        :class="statusClasses(inst)"
        @click="pickInstall(inst)"
        @contextmenu.prevent="openCardMenu($event, inst)"
      >
        <div class="chooser-tile-icon">
          <component :is="iconFor(inst.sourceCategory)" :size="28" />
        </div>
        <!-- Top-right cluster — error badge (when set) + kebab (⋮)
             button that anchors the per-tile action menu. The kebab
             stops the click from propagating up to the tile so it
             doesn't double-fire as a card click. -->
        <div class="chooser-tile-actions">
          <span
            v-if="hasError(inst)"
            class="chooser-tile-error"
            :title="$t('running.errors')"
          >
            <AlertCircle :size="16" />
          </span>
          <button
            type="button"
            class="chooser-tile-kebab"
            :title="$t('chooser.moreActions')"
            :aria-label="$t('chooser.moreActions')"
            @click.stop="openKebabMenu($event, inst)"
            @contextmenu.stop="openKebabMenu($event, inst)"
          >
            <MoreVertical :size="16" />
          </button>
        </div>
        <div class="chooser-tile-name">
          {{ inst.name }}
          <Pin
            v-if="prefs.isPinned(inst.id)"
            :size="13"
            class="chooser-tile-pin"
            :title="$t('dashboard.pinned')"
          />
        </div>
        <div class="chooser-tile-meta">
          <!-- Each datum is its own pill so they read as discrete
               chips rather than a dot-separated run-on line. Pills
               wrap onto a second row on narrow tiles instead of
               ellipsing. -->
          <!-- Source / channel pill: prefer `listPreview` when the
               source plugin populated one (e.g. "Stable" / "Latest"
               for the standalone source) so the channel reads
               instead of the bare source label. Falls back to the
               source label otherwise. The version pill is hidden
               when listPreview is set — that's the rule the legacy
               DashboardCard followed to avoid showing a raw commit
               sha next to "Latest" for tracking installs. -->
          <span class="chooser-tile-pill">
            {{ inst.listPreview || inst.sourceLabel }}
          </span>
          <span
            v-if="inst.version && !inst.listPreview"
            class="chooser-tile-pill chooser-tile-pill-version"
          >
            {{ inst.version }}
          </span>
          <!-- Update / migrate pills surface card-level prompts that
               previously only lived inside Install Settings. -->
          <span
            v-if="hasUpdate(inst) && !progressFor(inst)"
            class="chooser-tile-pill chooser-tile-pill-update"
            :title="inst.statusTag?.label"
          >
            <ArrowDownToLine :size="11" />
            {{ $t('chooser.updatePill') }}
          </span>
          <span
            v-if="hasMigratePrompt(inst) && !progressFor(inst)"
            class="chooser-tile-pill chooser-tile-pill-migrate"
            :title="$t('dashboard.migrateBannerTitle')"
          >
            <ArrowRightLeft :size="11" />
            {{ $t('chooser.migratePill') }}
          </span>
          <span v-if="!progressFor(inst)" class="chooser-tile-pill">
            {{ typeof inst.lastLaunchedAt === 'number'
              ? $t('dashboard.launchedAgo', { time: timeAgo(inst.lastLaunchedAt as number) })
              : $t('dashboard.neverLaunched') }}
          </span>
        </div>
        <!-- Progress block — visible only while a long-running op
             (install / update / restore / migrate) is in flight. The
             status line carries the live phase text and the progress
             track sits beneath it as a clear, prominent bar. The
             pattern mirrors the legacy DashboardCard `card-progress`
             treatment so users recognise the in-flight surface. -->
        <div v-if="progressFor(inst)" class="chooser-tile-progress">
          <div class="chooser-tile-progress-status">
            {{ progressFor(inst)!.status }}
          </div>
          <div
            class="chooser-tile-progress-track"
            :class="{ indeterminate: (progressFor(inst)!.percent ?? -1) < 0 }"
          >
            <div
              class="chooser-tile-progress-fill"
              :style="{
                width: (progressFor(inst)!.percent ?? -1) >= 0
                  ? `${progressFor(inst)!.percent}%`
                  : '40%',
              }"
            ></div>
          </div>
        </div>
      </button>
    </div>

    <ContextMenu
      :open="ctxMenu.open"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :items="ctxMenuItems"
      @close="closeMenu"
      @select="handleCtxMenuSelect"
    />

    <!-- Manage… overlay — DetailModal mounted in its modal-overlay
         mode (inline=false) so the user gets a focused dialog on top
         of the chooser grid rather than a full-screen panel. The
         outer `view-modal active` wrapper provides the backdrop +
         centering chrome (matches the pattern PanelApp uses for
         ProgressModal). DetailModal handles its own actions over
         IPC, so it works regardless of whether the chooser host has
         an install backing it. -->
    <Teleport to="body">
      <div
        v-if="manageInstall"
        class="view-modal active"
        data-overlay-key="manage-detail"
      >
        <DetailModal
          :installation="manageInstall"
          @close="closeManageModal"
          @navigate-list="handleManageNavigateList"
          @update:installation="handleManageUpdate"
          @show-progress="(opts) => emit('show-progress', opts)"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chooser-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.chooser-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 16px 24px 8px;
  flex-shrink: 0;
}

.chooser-filter-chip {
  background: transparent;
  color: inherit;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  padding: 4px 12px;
  font: inherit;
  font-size: 12px;
  border-radius: 999px;
  cursor: pointer;
  opacity: 0.8;
  transition: background-color 100ms ease, opacity 100ms ease, border-color 100ms ease;
}
.chooser-filter-chip:hover {
  opacity: 1;
}
.chooser-filter-chip.active {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.16));
  border-color: var(--border-strong, rgba(127, 127, 127, 0.4));
  opacity: 1;
}

.chooser-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
  padding: 48px 24px;
}

.chooser-grid {
  flex: 1;
  overflow-y: auto;
  /* Golden-ratio cards keep their aspect via `aspect-ratio` on the
     tile. Min column width is 320px — chooser tiles need to fit pills
     for source / version / last-launched plus the install name and
     icon, which 240px makes cramped. The auto-fill + 1fr columns let
     the grid grow more columns on wide windows; on narrow windows
     fewer columns appear and the grid scrolls vertically. */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  padding: 8px 24px 24px;
  align-content: start;
}

.chooser-tile {
  /* Golden ratio (1.618 : 1) — the design specifies tiles of this shape. */
  aspect-ratio: 1.618 / 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-end;
  gap: 6px;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--bg-elev-1, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.18));
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.chooser-tile:hover {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
  border-color: var(--border-strong, rgba(127, 127, 127, 0.4));
  transform: translateY(-1px);
}
.chooser-tile:focus-visible {
  outline: 2px solid var(--accent, #4a90e2);
  outline-offset: 2px;
}

.chooser-tile-icon {
  position: absolute;
  /* Float the icon to the top-left of the tile. */
  top: 14px;
  left: 16px;
  opacity: 0.85;
}
.chooser-tile {
  position: relative;
}

.chooser-tile-name {
  font-size: 16px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  /* Reserve space for the type icon at top-left so name doesn't collide. */
  margin-top: auto;
}
.chooser-tile-pin {
  opacity: 0.6;
}

.chooser-tile-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-width: 100%;
  font-size: 12px;
  /* Container-level mute applies to the New Install / Cloud tile's
   * plain-text meta line; pill chips inside install tiles override
   * the opacity locally so they read at full strength. */
  opacity: 0.85;
}

/* Pill chips for the meta line. Each piece of card metadata
 * (source label, version, last-launched timestamp) renders inside its
 * own pill so the run-on dot-separated line is gone — each datum
 * reads as a discrete chip the user can scan. Pills wrap onto a new
 * row on narrow tiles instead of ellipsing the line. */
.chooser-tile-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
  border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.18));
  font-size: 11px;
  white-space: nowrap;
  opacity: 0.9;
}
.chooser-tile-pill-version {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* Update-available pill — accent-blue tinted so it reads as
 * "informational, you can take action here" rather than "warning". The
 * icon + label format matches the migrate pill so they read as a pair
 * of card-level prompts. */
.chooser-tile-pill-update {
  gap: 4px;
  color: var(--accent, #4a90e2);
  background: var(--accent-soft, rgba(74, 144, 226, 0.12));
  border-color: var(--accent, #4a90e2);
  opacity: 1;
}

/* Migrate-available pill — uses the warning amber so it's visually
 * distinct from the update pill (an action that materially changes the
 * install vs. an in-place update). Same icon-plus-label layout. */
.chooser-tile-pill-migrate {
  gap: 4px;
  color: var(--accent-warning, #d97706);
  background: var(--accent-warning-soft, rgba(217, 119, 6, 0.12));
  border-color: var(--accent-warning, #d97706);
  opacity: 1;
}

/* In-flight progress block — visible only when an op is running for
 * this install. Sits beneath the meta line and replaces the
 * last-launched / update / migrate pills (those are hidden in the
 * template while progressFor is non-null). The status line + track
 * pattern matches the legacy DashboardCard `card-progress` block so
 * users recognise the in-flight surface. */
.chooser-tile-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  margin-top: 2px;
}
.chooser-tile-progress-status {
  font-size: 11px;
  color: var(--accent, #4a90e2);
  /* Status strings can be long ("Resolving dependencies…",
   * "Restoring snapshot snapshot-2026-01-15.zip"). Single-line
   * ellipsis so the row stays within the tile. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chooser-tile-progress-track {
  position: relative;
  height: 6px;
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.16));
  border-radius: 3px;
  overflow: hidden;
}
.chooser-tile-progress-fill {
  height: 100%;
  background: var(--accent, #4a90e2);
  transition: width 200ms ease;
}
.chooser-tile-progress-track.indeterminate .chooser-tile-progress-fill {
  animation: chooser-tile-progress-sweep 1.4s ease-in-out infinite;
}
@keyframes chooser-tile-progress-sweep {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

/* Status overlays — match the visual language used by DashboardCard so
 * users recognise the running / stopping / in-progress / errored states.
 * Running uses the accent blue (per §8 spec) so it reads as "this is
 * the live one"; errored uses the danger red so it reads as "look at
 * this one". The two states are mutually exclusive in practice
 * (errored installs aren't currently running), but the CSS handles
 * both being set just in case. */
.chooser-tile-running {
  box-shadow: inset 0 0 0 2px var(--accent, #4a90e2);
}
.chooser-tile-errored {
  box-shadow: inset 0 0 0 2px var(--accent-danger, #d92d20);
}
.chooser-tile-running.chooser-tile-errored {
  /* Errored takes precedence visually if both happen to be set —
   * a crashed-while-running install reads more usefully as "errored". */
  box-shadow: inset 0 0 0 2px var(--accent-danger, #d92d20);
}
.chooser-tile-stopping,
.chooser-tile-in-progress {
  opacity: 0.7;
}

/* Top-right cluster — error badge + kebab (⋮) action button. Sits
 * absolute-positioned in the top-right corner of every install tile.
 * The kebab is the primary affordance for per-tile actions (Pin /
 * Manage / Dismiss); the error badge is purely a visibility indicator
 * (click-to-dismiss is a menu item, not a tap target on the badge).
 * The cluster lives above the icon's top-left position; the source
 * icon is at top-left, so the two never collide. */
.chooser-tile-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  z-index: 1;
}
.chooser-tile-error {
  color: var(--accent-danger, #d92d20);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  padding: 0 4px;
}
.chooser-tile-kebab {
  /* Reset native button chrome — we render a flat icon button. */
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px;
  color: inherit;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.65;
  transition: background-color 100ms ease, opacity 100ms ease, border-color 100ms ease;
}
.chooser-tile-kebab:hover,
.chooser-tile-kebab:focus-visible {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.18));
  border-color: var(--border-strong, rgba(127, 127, 127, 0.4));
  opacity: 1;
  outline: none;
}

/* The two fixed-position tiles (New Install + Cloud) get a slightly
 * different treatment so they read as entry-points, not data rows. */
.chooser-tile-new {
  background: var(--accent-soft, rgba(74, 144, 226, 0.10));
  border-style: dashed;
  border-color: var(--border-strong, rgba(127, 127, 127, 0.4));
}
.chooser-tile-new:hover {
  background: var(--accent-soft-hover, rgba(74, 144, 226, 0.18));
}
.chooser-tile-cloud {
  background: var(--bg-elev-1, rgba(127, 127, 127, 0.08));
}
</style>
