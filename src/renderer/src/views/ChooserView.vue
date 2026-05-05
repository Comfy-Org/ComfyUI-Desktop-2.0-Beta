<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useOverlay, type ManageOverlay } from '../composables/useOverlay'
import { Cloud, Plus, Box, Monitor, Globe, Pin, AlertCircle, ArrowDownToLine, ArrowRightLeft, MoreVertical, Play, ExternalLink, Square, Loader2 } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
import DetailModal from './DetailModal.vue'
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
// The card body's bare click goes through `openManage` — the fast-
// path for "tell me about this install" — and the kebab
// `stopPropagation`s so it doesn't double-fire as a card click.
//
// Phase 3 §17 — the chooser owns its own overlay slot so Manage opens
// without the Teleport-to-body hack the §8 rebuild used. The slot is
// Tier 1; Tier 2/3 ops kicked off from the modal flow up to PanelApp's
// own slot which pre-empts this one visually (its z-index is higher).
const { current: currentOverlay, openOverlay, closeOverlay } = useOverlay()

/** Currently-mounted Manage overlay payload, or null. Computed from
 *  `currentOverlay` so the template binds plain refs. Manage is the
 *  only `kind` ChooserView mounts in its own slot today. */
const manageOverlay = computed<ManageOverlay | null>(() =>
  currentOverlay.value?.kind === 'manage' ? currentOverlay.value : null
)

/**
 * Open the Manage modal for `inst` in the chooser's overlay slot.
 *
 * Single entry-point that replaces the per-call-site duplication the
 * §8 chooser had: the kebab/right-click `onManage` callback, the
 * card-body single-click handler, and the update / migrate pill
 * click handlers all funnel through here with their preferred
 * `initialTab` / `autoAction` deep-link parameters.
 */
function openManage(
  installation: Installation,
  opts: { initialTab?: string; autoAction?: string | null } = {},
): void {
  void openOverlay({
    kind: 'manage',
    installation,
    initialTab: opts.initialTab ?? 'status',
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
} = useInstallContextMenu({
  onManage: (inst) => openManage(inst),
})

/** DetailModal `update:installation` event — the user edited the
 *  install (renamed it, changed its launch settings, etc.). Splice
 *  the new record in place so the modal and the underlying card stay
 *  in sync without round-tripping through `getInstallations`, and
 *  refresh the overlay payload so DetailModal's `installation` prop
 *  picks up the new fields. Mirrors the pattern PanelApp uses for the
 *  install-settings DetailModal. */
function handleManageUpdate(inst: Installation): void {
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
  if (manageOverlay.value) {
    currentOverlay.value = { ...manageOverlay.value, installation: inst }
  }
}

/** DetailModal `navigate-list` event — the install was deleted /
 *  migrated. Close the overlay so the user is returned to the chooser
 *  grid; the installationsChanged broadcast already updated the store
 *  so the deleted card has dropped out of `visibleInstalls`. */
function handleManageNavigateList(): void {
  void closeOverlay()
}

/** DetailModal `show-progress` event — bubble straight up to PanelApp.
 *  PanelApp's host-level overlay slot is Tier 2 and pre-empts this
 *  Tier 1 manage overlay automatically (its DOM node sits at a higher
 *  z-index over the chooser's slot). The legacy `actionId === 'launch'`
 *  swap-in-place special-case is gone — the takeover-replaces-modal
 *  rule subsumes it; the launch action's progress runs in the shared
 *  ProgressModal like everything else and the eventual swap to the
 *  install host happens after the takeover ends. */
function handleManageShowProgress(opts: ShowProgressOpts): void {
  emit('show-progress', opts)
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

/** Running card — focus the install's existing ComfyUI window
 *  instead of trying to start a fresh one. Mirrors the legacy
 *  DashboardCard "Show Window" CTA. */
function focusInstance(inst: Installation): void {
  void window.api.focusComfyWindow(inst.id)
}

/** Running card — stop the install's ComfyUI process. Mirrors the
 *  legacy DashboardCard danger-solid Stop CTA. The session-status
 *  broadcast flips the card's running class off, the Play button
 *  comes back on its own. */
function stopInstance(inst: Installation): void {
  void window.api.stopComfyUI(inst.id)
}

/** In-progress card — re-open the ProgressModal for the operation
 *  already running against this install. The active session lives
 *  in `progressStore`; emitting `show-progress` with a no-op
 *  `apiCall` triggers PanelApp's existing-operation branch which
 *  just re-shows the modal without spawning a duplicate. */
function viewProgress(inst: Installation): void {
  emit('show-progress', {
    installationId: inst.id,
    title: '',
    apiCall: async () => ({}),
  })
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
           Single-click on the tile body opens the Manage modal —
           the implicit "click-to-launch" gesture was confusing
           ("did clicking just kick off a process?"), so the explicit
           Play button (overlaid bottom-right) is the launch CTA and
           a double-click on the tile body is the convenience
           gesture for the same. The kebab (⋮) and Play button
           `@click.stop` so they don't double-fire as a card click.
           Right-click opens the kebab's menu at pointer coords as a
           power-user gesture. We can't use a native <button> for
           the tile because it carries a <button> kebab + Play CTA
           inside; nested buttons aren't valid HTML, so the tile is
           a `role="button"` div with explicit Enter/Space handlers
           for keyboard activation. -->
      <div
        v-for="inst in visibleInstalls"
        :key="inst.id"
        role="button"
        tabindex="0"
        class="chooser-tile"
        :class="statusClasses(inst)"
        @click="openManage(inst)"
        @dblclick="pickInstall(inst)"
        @keydown.enter="openManage(inst)"
        @keydown.space.prevent="openManage(inst)"
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
               pill is a click target that opens the Manage modal
               directly on the relevant surface (Update tab /
               migrate-to-standalone auto-action) — the legacy
               DashboardCard wired the same `show-update` /
               `show-migrate` shortcuts and the chooser was missing
               them after the §8 rebuild. `@click.stop` prevents the
               pill click from bubbling up to the tile body's bare
               `pickInstall` handler. -->
          <span
            v-if="hasUpdate(inst) && !progressFor(inst)"
            class="chooser-tile-pill chooser-tile-pill-update"
            role="button"
            tabindex="0"
            :title="inst.statusTag?.label"
            @click.stop="openManage(inst, { initialTab: 'update' })"
            @keydown.enter.stop="openManage(inst, { initialTab: 'update' })"
            @keydown.space.prevent.stop="openManage(inst, { initialTab: 'update' })"
          >
            <ArrowDownToLine :size="11" />
            {{ $t('chooser.updatePill') }}
          </span>
          <span
            v-if="hasMigratePrompt(inst) && !progressFor(inst)"
            class="chooser-tile-pill chooser-tile-pill-migrate"
            role="button"
            tabindex="0"
            :title="$t('dashboard.migrateBannerTitle')"
            @click.stop="openManage(inst, { autoAction: 'migrate-to-standalone' })"
            @keydown.enter.stop="openManage(inst, { autoAction: 'migrate-to-standalone' })"
            @keydown.space.prevent.stop="openManage(inst, { autoAction: 'migrate-to-standalone' })"
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
        <!-- CTA cluster — overlay positioned bottom-right of the
             tile. The button shown depends on the install's lifecycle
             state (highest priority first):
               - in-progress: "View Progress" reopens the existing
                 ProgressModal for the operation already running.
               - stopping: the running pair is shown disabled (the
                 process is in mid-shutdown — Stop has been pressed
                 but the OS hasn't reaped the PID yet).
               - running: "Show Window" focuses the existing ComfyUI
                 window + a Stop button kills the process.
               - installed (idle): "Play" launches via pickInstall,
                 routing through PanelApp's chooser-pick pipeline.
             Each button `@click.stop`s so it doesn't double-fire as
             a card-body click (which opens Manage). -->
        <div class="chooser-tile-cta">
          <template v-if="progressFor(inst)">
            <button
              type="button"
              class="chooser-tile-cta-btn chooser-tile-cta-progress"
              :title="$t('list.viewProgress')"
              :aria-label="$t('list.viewProgress')"
              @click.stop="viewProgress(inst)"
            >
              <Loader2 :size="16" class="chooser-tile-cta-spin" />
            </button>
          </template>
          <template v-else-if="sessionStore.isStopping(inst.id)">
            <button
              type="button"
              class="chooser-tile-cta-btn chooser-tile-cta-stop"
              :title="$t('console.stopping')"
              :aria-label="$t('console.stopping')"
              disabled
            >
              <Square :size="14" />
            </button>
          </template>
          <template v-else-if="sessionStore.isRunning(inst.id)">
            <button
              type="button"
              class="chooser-tile-cta-btn chooser-tile-cta-show"
              :title="$t('running.showWindow')"
              :aria-label="$t('running.showWindow')"
              @click.stop="focusInstance(inst)"
            >
              <ExternalLink :size="16" />
            </button>
            <button
              type="button"
              class="chooser-tile-cta-btn chooser-tile-cta-stop"
              :title="$t('console.stop')"
              :aria-label="$t('console.stop')"
              @click.stop="stopInstance(inst)"
            >
              <Square :size="14" />
            </button>
          </template>
          <template v-else-if="inst.status === 'installed'">
            <button
              type="button"
              class="chooser-tile-cta-btn chooser-tile-cta-play"
              :title="$t('actions.launch')"
              :aria-label="$t('actions.launch')"
              @click.stop="pickInstall(inst)"
            >
              <Play :size="16" />
            </button>
          </template>
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

    <!-- Chooser overlay slot (Phase 3 §17). Owned by the local
         `useOverlay` instance — Tier 1 today (Manage modal). Mounted
         inline in the chooser's tree so the §8 Teleport-to-body hack
         is gone; the unified-window contract treats chooser-host and
         install-host overlays uniformly. PanelApp's host-level slot
         renders Tier 2/3 overlays at a higher z-index, so an op
         kicked off from the Manage modal visually pre-empts it
         without needing this slot to react. DetailModal handles its
         own actions over IPC, so it works regardless of whether the
         chooser host has an install backing it. -->
    <div
      v-if="manageOverlay"
      class="view-modal active"
      data-overlay-key="manage-detail"
    >
      <DetailModal
        :installation="manageOverlay.installation"
        :initial-tab="manageOverlay.initialTab"
        :auto-action="manageOverlay.autoAction"
        @close="closeOverlay"
        @navigate-list="handleManageNavigateList"
        @update:installation="handleManageUpdate"
        @show-progress="handleManageShowProgress"
      />
    </div>
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
  /* Reserve space at the bottom-right for the absolutely-positioned
   * CTA cluster (Play / Show Window + Stop / View Progress) so meta
   * pills don't run under it on narrow tiles. The reservation
   * accommodates the widest cluster (Show Window + Stop = ~82px). */
  padding-right: 92px;
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

/* CTA cluster — overlay anchored to the bottom-right of each tile.
 * Sits above the meta line so it's the first thing the user reaches
 * for. The buttons inside are explicit launch / show window / stop /
 * view-progress targets, distinct from the card body's "open Manage"
 * single-click gesture. */
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
/* Play (idle / launch) — solid accent fill, the primary CTA. */
.chooser-tile-cta-play {
  background: var(--accent, #4a90e2);
  color: var(--bg, #fff);
  border-color: var(--accent, #4a90e2);
}
.chooser-tile-cta-play:hover:not(:disabled),
.chooser-tile-cta-play:focus-visible {
  background: var(--accent-hover, #3a7bc8);
  border-color: var(--accent-hover, #3a7bc8);
}
/* Show Window (running) — accent outline, signals "navigate to the
 * existing window" rather than "kick off a new process". */
.chooser-tile-cta-show {
  color: var(--accent, #4a90e2);
  border-color: var(--accent, #4a90e2);
  background: var(--accent-soft, rgba(74, 144, 226, 0.12));
}
.chooser-tile-cta-show:hover:not(:disabled),
.chooser-tile-cta-show:focus-visible {
  background: var(--accent-soft-hover, rgba(74, 144, 226, 0.22));
}
/* Stop (running) — danger fill so it reads as a destructive CTA
 * even at the small CTA-button size. */
.chooser-tile-cta-stop {
  background: var(--accent-danger, #d92d20);
  color: var(--bg, #fff);
  border-color: var(--accent-danger, #d92d20);
}
.chooser-tile-cta-stop:hover:not(:disabled),
.chooser-tile-cta-stop:focus-visible {
  background: var(--accent-danger-hover, #b8241a);
  border-color: var(--accent-danger-hover, #b8241a);
}
/* View Progress (in-flight) — accent outline + spinner so it reads
 * as "an op is running, click to peek". */
.chooser-tile-cta-progress {
  color: var(--accent, #4a90e2);
  border-color: var(--accent, #4a90e2);
  background: var(--accent-soft, rgba(74, 144, 226, 0.12));
}
.chooser-tile-cta-spin {
  animation: chooser-tile-cta-spin 1.2s linear infinite;
}
@keyframes chooser-tile-cta-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
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
