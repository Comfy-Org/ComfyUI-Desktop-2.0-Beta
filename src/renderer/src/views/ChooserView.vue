<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useOverlay } from '../composables/useOverlay'
import { Cloud, Plus, AlertCircle, ArrowDownToLine, ArrowRightLeft, MoreVertical, X } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
import { installTypeMetaFor } from '../lib/installTypeIcon'
import type { Installation, ShowProgressOpts } from '../types/ipc'

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
   *  (`PanelApp`) owns the ProgressModal overlay; we forward most
   *  events so it can wire the operation through `progressStore`.
   *  Launch is the one exception — see `handleManageShowProgress`. */
  'show-progress': [opts: ShowProgressOpts]
}>()

const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const progressStore = useProgressStore()

onMounted(() => {
  if (installationStore.installations.length === 0) {
    void installationStore.fetchInstallations()
  }
})

// --- Filter chips ---
//
// "Local" includes both standalone local installs and Legacy Desktop
// installs (`sourceCategory === 'desktop'`) — Legacy Desktop is the
// pre-2.0 install kind, conceptually the same family as Local from the
// dashboard user's POV. The dedicated Desktop chip was retired in the
// post-Phase 3 dashboard cleanup so the filter row stays compact and
// Legacy Desktop installs surface alongside their Standalone siblings.
type FilterKey = 'all' | 'local' | 'cloud' | 'remote'
const activeFilter = ref<FilterKey>('all')

interface FilterChip { key: FilterKey; labelKey: string }
const filterChips: FilterChip[] = [
  { key: 'all', labelKey: 'chooser.filterAll' },
  { key: 'local', labelKey: 'chooser.filterLocal' },
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

/** Apply the active filter to the non-cloud list. The Local chip
 *  includes Legacy Desktop installs (`sourceCategory === 'desktop'`)
 *  since the dedicated Desktop chip was retired — see the FilterKey
 *  comment above. */
const visibleInstalls = computed<Installation[]>(() => {
  const sorted = [...nonCloudInstalls.value].sort(sortByRecency)
  switch (activeFilter.value) {
    case 'all': return sorted
    case 'local': return sorted.filter((i) => i.sourceCategory === 'local' || i.sourceCategory === 'desktop')
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

// --- Type icon mapping — visible on each card so source kind is obvious.
// The same mapping (and its short i18n label) drives the Comfy Instance
// title bar's source-category indicator (Track B), so the icon vocabulary
// can't drift between the two surfaces. See `lib/installTypeIcon.ts` for
// the per-category icon choices and rationale (notably: Standalone reads
// as a modern laptop while Legacy Desktop reads as an older desktop tower
// silhouette so the two install types are visibly distinct at a glance).

// --- Action / context menu (Manage / Dismiss error) ---
// The same composable powers two surfaces:
//   - Right-click on a card → context menu at click coords.
//   - Click on the kebab (⋮) button at the top-right of a card →
//     dropdown anchored to the button.
// Both menus carry the same items: Manage… (opens the unified
// Settings modal on the ComfyUI Settings tab) and Dismiss error
// (when set), plus the per-install Update / Migrate / Restore
// Snapshot / Open Folder / Delete actions surfaced by
// `useInstallContextMenu`. The card body itself launches the
// install — Manage is reachable only via the kebab and right-click.
const { openOverlay } = useOverlay()

/**
 * Open the unified Settings modal on the ComfyUI Settings tab for
 * `inst`. Single entry-point that the kebab/right-click `onManage`
 * callback and the update / migrate pill click handlers funnel
 * through with their preferred `initialTab` / `autoAction` deep-
 * link parameters (forwarded to the embedded DetailModal). The
 * overlay is owned by the singleton `useOverlay`; `PanelApp`
 * mounts the SettingsModal in its host-level overlay slot.
 */
function openManage(
  installation: Installation,
  opts: { initialTab?: string; autoAction?: string | null } = {},
): void {
  void openOverlay({
    kind: 'settings',
    installation,
    initialTab: 'comfy',
    initialDetailTab: opts.initialTab ?? 'status',
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
  isStoppedActionGated,
} = useInstallContextMenu({
  onManage: (inst, opts) => openManage(inst, opts ?? {}),
})



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

/** Re-open the ProgressModal for the operation already running
 *  against this install. The active session lives in `progressStore`;
 *  emitting `show-progress` with a no-op `apiCall` triggers PanelApp's
 *  existing-operation branch which just re-shows the modal without
 *  spawning a duplicate. */
function viewProgress(inst: Installation): void {
  emit('show-progress', {
    installationId: inst.id,
    title: '',
    apiCall: async () => ({}),
  })
}

/**
 * Single body-click handler for both the Cloud tile and per-install
 * tiles. Behaviour by lifecycle state, in priority order:
 *   - in-flight op → re-open the ProgressModal for it.
 *   - stopping → no-op (the process is mid-shutdown; nothing
 *     useful to do on click).
 *   - otherwise → `pickInstall`, which routes through
 *     `performChooserLaunch` in PanelApp. That helper already
 *     short-circuits to `focusComfyWindow` when the install is
 *     already running, and otherwise launches it. So a single
 *     click covers idle-launch, running-focus, and view-progress
 *     without per-state CTAs on the card.
 */
function handleTileClick(inst: Installation): void {
  if (progressFor(inst)) {
    viewProgress(inst)
    return
  }
  if (sessionStore.isStopping(inst.id)) return
  pickInstall(inst)
}

/** Close the install's ComfyUI window AND its underlying process.
 *  The window's main-side `close` handler runs the full teardown
 *  (`_installCleanup` → `ipc.stopRunning` → webContents close →
 *  destroy), so calling `closeComfyWindow` is enough — no separate
 *  `stopComfyUI` call needed, and the user doesn't get left looking
 *  at a stale "ComfyUI is stopped" lifecycle screen.
 *
 *  Focus the install window first so that if main's `close` handler
 *  ends up consulting the panel renderer (active Tier 2 / Tier 3
 *  overlay), the resulting cancel prompt is visible — without this
 *  the dashboard window stays in front and the prompt would be
 *  hidden behind it. */
async function closeRunningInstance(inst: Installation): Promise<void> {
  await window.api.focusComfyWindow(inst.id)
  await window.api.closeComfyWindow(inst.id)
}

function handleCloudClick(): void {
  // If there's an existing cloud install, route through the same
  // body-click handler the install tiles use so behaviour can't
  // drift between the two surfaces. Otherwise promote the
  // new-install flow as a Try-Cloud CTA.
  if (cloudInstall.value) {
    handleTileClick(cloudInstall.value)
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
           Single-click on the tile body launches / focuses /
           re-opens-progress for the install (see `handleTileClick` in
           the script section) — the same gesture the Cloud tile uses
           so behaviour can't drift between the two. Manage…, Update,
           Migrate, Open Folder, Delete, Dismiss-error all live behind
           the kebab (⋮) button and right-click context menu. The
           kebab and the Close-instance CTA `@click.stop` so they don't
           double-fire as a card click. We can't use a native <button>
           for the tile because it carries a <button> kebab + Close
           CTA inside; nested buttons aren't valid HTML, so the tile
           is a `role="button"` div with explicit Enter/Space handlers
           for keyboard activation. -->

      <div
        v-for="inst in visibleInstalls"
        :key="inst.id"
        role="button"
        tabindex="0"
        class="chooser-tile"
        :class="statusClasses(inst)"
        @click="handleTileClick(inst)"
        @keydown.enter="handleTileClick(inst)"
        @keydown.space.prevent="handleTileClick(inst)"
        @contextmenu.prevent="openCardMenu($event, inst)"
      >
        <div
          class="chooser-tile-icon"
          :title="$t(installTypeMetaFor(inst.sourceCategory).labelKey)"
        >
          <component :is="installTypeMetaFor(inst.sourceCategory).icon" :size="28" />
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
        <!-- Progress block — visible only while a long-running op
             (install / update / restore / migrate) is in flight. Sits
             in the empty top-of-tile gap between the source icon
             (top-left) and the action cluster (top-right) so the
             progress bar never overlaps the bottom-right CTA cluster.
             The status line carries the live phase text and the
             progress track sits beneath it as a clear, prominent
             bar. The pattern mirrors the legacy DashboardCard
             `card-progress` treatment so users recognise the in-flight
             surface. -->
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
        <div class="chooser-tile-name">
          {{ inst.name }}
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
               source label otherwise. -->
          <span class="chooser-tile-pill">
            {{ inst.listPreview || inst.sourceLabel }}
          </span>
          <!-- Version pill — channel and version are independent
               facts: the channel reads as "what stream am I tracking"
               while the version reads as "what point on that stream
               am I currently at" (e.g. `v0.14.2+21` for a Latest
               install 21 commits ahead of the v0.14.2 tag). The
               legacy DashboardCard hid this when listPreview was set
               but the legacy InstallationList showed it
               unconditionally — the chooser is now the only surface
               that lists installs, so we restore the always-on
               behaviour to avoid losing the at-a-glance "what am I
               on" affordance. -->
          <span
            v-if="inst.version"
            class="chooser-tile-pill chooser-tile-pill-version"
          >
            {{ inst.version }}
          </span>
          <!-- Update / migrate pills surface card-level prompts that
               previously only lived inside Install Settings. Each
               pill is a click target that opens the unified Settings
               modal on the ComfyUI Settings tab / relevant inner
               surface (Update tab / migrate-to-standalone
               auto-action). `@click.stop` prevents the pill click
               from bubbling up to the tile body's `handleTileClick`
               handler.

               Both pills wrap REQUIRES_STOPPED actions, so they
               render in a visibly disabled state (and their click /
               keyboard handlers no-op) whenever
               `isStoppedActionGated(inst)` is true — same predicate
               that gates the matching kebab-menu items. -->
          <span
            v-if="hasUpdate(inst) && !progressFor(inst)"
            class="chooser-tile-pill chooser-tile-pill-update"
            :class="{ 'chooser-tile-pill-disabled': isStoppedActionGated(inst) }"
            role="button"
            tabindex="0"
            :aria-disabled="isStoppedActionGated(inst) || undefined"
            :title="inst.statusTag?.label"
            @click.stop="isStoppedActionGated(inst) || triggerAction('update', inst)"
            @keydown.enter.stop="isStoppedActionGated(inst) || triggerAction('update', inst)"
            @keydown.space.prevent.stop="isStoppedActionGated(inst) || triggerAction('update', inst)"
          >
            <ArrowDownToLine :size="11" />
            {{ $t('chooser.updatePill') }}
          </span>
          <span
            v-if="hasMigratePrompt(inst) && !progressFor(inst)"
            class="chooser-tile-pill chooser-tile-pill-migrate"
            :class="{ 'chooser-tile-pill-disabled': isStoppedActionGated(inst) }"
            role="button"
            tabindex="0"
            :aria-disabled="isStoppedActionGated(inst) || undefined"
            :title="$t('dashboard.migrateBannerTitle')"
            @click.stop="isStoppedActionGated(inst) || triggerAction('migrate', inst)"
            @keydown.enter.stop="isStoppedActionGated(inst) || triggerAction('migrate', inst)"
            @keydown.space.prevent.stop="isStoppedActionGated(inst) || triggerAction('migrate', inst)"
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
        <!-- CTA cluster — overlay positioned bottom-right of the
             tile. Only rendered while the install is running or
             stopping, as a single "Close instance" button. Tapping
             it routes through main's `closeComfyWindow` IPC, which
             closes the OS window AND tears the process down via the
             window's existing `close` handler — no separate Stop
             call needed and the user doesn't get left looking at
             the lifecycle "ComfyUI is stopped" screen.
             For idle / in-progress states the body click handler
             (`handleTileClick`) does the right thing on its own
             (launch / view-progress), so no CTA is needed. -->
        <div
          v-if="sessionStore.isRunning(inst.id) || sessionStore.isStopping(inst.id)"
          class="chooser-tile-cta"
        >
          <button
            type="button"
            class="chooser-tile-cta-btn chooser-tile-cta-close"
            :title="$t('console.stop')"
            :aria-label="$t('console.stop')"
            :disabled="sessionStore.isStopping(inst.id)"
            @click.stop="closeRunningInstance(inst)"
          >
            <X :size="16" />
          </button>
        </div>
      </div>
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
  /* Reserve space at the bottom-right for the absolutely-positioned
   * Close-instance CTA so meta pills don't run under it on narrow
   * tiles. Single 32px button + 12px right inset = ~50px. The CTA
   * is only rendered while running / stopping, but the reservation
   * is unconditional — leaving the bottom-right corner clear in
   * idle / in-progress states keeps the visual rhythm steady as the
   * button appears / disappears. */
  padding-right: 50px;
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
 * of card-level prompts. Pointer cursor + hover lift telegraph that
 * the pill is its own click target (opens the Update tab of the
 * Manage modal); the same applies to .chooser-tile-pill-migrate. */
.chooser-tile-pill-update {
  gap: 4px;
  color: var(--accent, #4a90e2);
  background: var(--accent-soft, rgba(74, 144, 226, 0.12));
  border-color: var(--accent, #4a90e2);
  opacity: 1;
  cursor: pointer;
  transition: background-color 0.12s, border-color 0.12s, transform 0.12s;
}
.chooser-tile-pill-update:hover,
.chooser-tile-pill-update:focus-visible {
  background: var(--accent-soft-hover, rgba(74, 144, 226, 0.22));
  outline: none;
}
.chooser-tile-pill-update:focus-visible {
  outline: 2px solid var(--accent, #4a90e2);
  outline-offset: 2px;
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
  cursor: pointer;
  transition: background-color 0.12s, border-color 0.12s, transform 0.12s;
}
.chooser-tile-pill-migrate:hover,
.chooser-tile-pill-migrate:focus-visible {
  background: var(--accent-warning-soft-hover, rgba(217, 119, 6, 0.22));
  outline: none;
}
.chooser-tile-pill-migrate:focus-visible {
  outline: 2px solid var(--accent-warning, #d97706);
  outline-offset: 2px;
}

/* Disabled (gated) state for action pills — applied whenever the
 * underlying REQUIRES_STOPPED action would no-op (install running /
 * stopping / op in flight). The pill stays visible so the user
 * knows the action exists; the dimmed colour + default cursor
 * signal it isn't currently actionable. Hover/focus highlights are
 * suppressed and the click handlers no-op while gated. Matches the
 * uniform "disabled" treatment ContextMenu applies to the matching
 * kebab-menu items. */
.chooser-tile-pill-disabled {
  opacity: 0.45;
  cursor: default;
}
.chooser-tile-pill-disabled:hover,
.chooser-tile-pill-disabled:focus-visible {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
  outline: none;
}
.chooser-tile-pill-update.chooser-tile-pill-disabled:hover,
.chooser-tile-pill-update.chooser-tile-pill-disabled:focus-visible {
  background: var(--accent-soft, rgba(74, 144, 226, 0.12));
}
.chooser-tile-pill-migrate.chooser-tile-pill-disabled:hover,
.chooser-tile-pill-migrate.chooser-tile-pill-disabled:focus-visible {
  background: var(--accent-warning-soft, rgba(217, 119, 6, 0.12));
}

/* In-flight progress block — visible only when an op is running for
 * this install. Lives in the empty top-of-tile gap between the source
 * icon (top-left, absolute @ ~top:14, left:16, size:28) and the
 * action cluster (top-right, absolute @ ~top:8, right:8 carrying the
 * kebab + optional error badge). Padded horizontally to clear both
 * absolute clusters; the bottom-right CTA cluster is also absolute
 * and well below where the progress bar sits. The last-launched /
 * update / migrate pills inside `chooser-tile-meta` still hide while
 * progressFor is non-null (the template gates them). The status line
 * + track pattern matches the legacy DashboardCard `card-progress`
 * block so users recognise the in-flight surface. */
.chooser-tile-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  /* Clear the source icon (top-left) and the kebab/error cluster
   * (top-right). Empirical paddings — keep the bar visually centered
   * in the upper gap on common card widths. */
  padding-left: 36px;
  padding-right: 56px;
  box-sizing: border-box;
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
 * The kebab is the primary affordance for per-tile actions (Manage /
 * Update / Migrate / Open Folder / Delete / Dismiss); the error
 * badge is purely a visibility indicator
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

/* CTA cluster — overlay anchored to the bottom-right of each tile.
 * Sits above the meta line so it's the first thing the user reaches
 * for. The buttons inside are explicit launch / show window / stop /
 * view-progress targets, distinct from the card body's single-click
 * launch / focus-running-window gesture. */
.chooser-tile-cta {
  position: absolute;
  right: 12px;
  bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 1;
}
.chooser-tile-cta-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  border: 1px solid var(--border-strong, rgba(127, 127, 127, 0.4));
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
  color: inherit;
  cursor: pointer;
  padding: 0;
  transition: background-color 100ms ease, border-color 100ms ease, transform 100ms ease, color 100ms ease;
}
.chooser-tile-cta-btn:hover:not(:disabled),
.chooser-tile-cta-btn:focus-visible {
  transform: scale(1.05);
  outline: none;
}
.chooser-tile-cta-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* Close instance (running / stopping) — danger fill so it reads as
 * a destructive CTA even at the small CTA-button size. Disabled
 * (mid-shutdown) inherits the muted base treatment. */
.chooser-tile-cta-close {
  background: var(--accent-danger, #d92d20);
  color: var(--bg, #fff);
  border-color: var(--accent-danger, #d92d20);
}
.chooser-tile-cta-close:hover:not(:disabled),
.chooser-tile-cta-close:focus-visible {
  background: var(--accent-danger-hover, #b8241a);
  border-color: var(--accent-danger-hover, #b8241a);
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
