<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useProgressStore } from '../stores/progressStore'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { useOverlay } from '../composables/useOverlay'
import { Cloud, Plus } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
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

// --- Filter chips ---
//
// "Local" includes both standalone local installs and Legacy Desktop
// installs (`sourceCategory === 'desktop'`) — Legacy Desktop is the
// pre-2.0 install kind, conceptually the same family as Local from
// the user's POV. There's no dedicated Desktop chip so the filter row
// stays compact.
type FilterKey = 'all' | 'local' | 'cloud' | 'remote'
const activeFilter = ref<FilterKey>('all')

interface FilterChip { key: FilterKey; labelKey: string }
const filterChips: FilterChip[] = [
  { key: 'all', labelKey: 'chooser.filterAll' },
  { key: 'local', labelKey: 'chooser.filterLocal' },
  { key: 'cloud', labelKey: 'chooser.filterCloud' },
  { key: 'remote', labelKey: 'chooser.filterRemote' },
]

const cloudInstall = computed<Installation | null>(() =>
  installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null,
)

const nonCloudInstalls = computed<Installation[]>(() =>
  installationStore.installations.filter((i) => i.sourceCategory !== 'cloud'),
)

function sortByRecency(a: Installation, b: Installation): number {
  const ta = typeof a.lastLaunchedAt === 'number' ? a.lastLaunchedAt : -Infinity
  const tb = typeof b.lastLaunchedAt === 'number' ? b.lastLaunchedAt : -Infinity
  return tb - ta
}

const visibleInstalls = computed<Installation[]>(() => {
  const sorted = [...nonCloudInstalls.value].sort(sortByRecency)
  switch (activeFilter.value) {
    case 'all': return sorted
    case 'local': return sorted.filter((i) => i.sourceCategory === 'local' || i.sourceCategory === 'desktop')
    case 'remote': return sorted.filter((i) => i.sourceCategory === 'remote')
    case 'cloud': return [] // Cloud installs only appear in the Cloud tile.
    default: return sorted
  }
})

const showCloudCard = computed(() =>
  activeFilter.value === 'all' || activeFilter.value === 'cloud',
)

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

function lastLaunchedLabel(inst: Installation): string {
  return typeof inst.lastLaunchedAt === 'number'
    ? t('dashboard.launchedAgo', { time: timeAgo(inst.lastLaunchedAt) })
    : t('dashboard.neverLaunched')
}

// --- Manage / context menu ---
const { openOverlay } = useOverlay()

function openManage(
  installation: Installation,
  opts: { initialTab?: string; autoAction?: string | null } = {},
): void {
  // `noSidebar: true` collapses the unified Settings modal to just this
  // install's ComfyUI Settings surface — the user picked a specific
  // install via the kebab/right-click, so cross-install tabs are noise.
  // The file-menu Settings entry leaves the flag unset and gets the
  // full sidebar layout.
  void openOverlay({
    kind: 'settings',
    installation,
    initialTab: 'comfy',
    initialDetailTab: opts.initialTab ?? 'status',
    autoAction: opts.autoAction ?? null,
    noSidebar: true,
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
    apiCall: async () => ({}),
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
  <div v-show="props.visible" class="chooser-view">
    <!-- Filter chips: narrow the grid by source category. New Install +
         Cloud stay visible regardless (they're entry-points, not data
         rows) — except Cloud is hidden when filtering to local/remote. -->
    <div class="chooser-filters filter-pill-group">
      <button
        v-for="chip in filterChips"
        :key="chip.key"
        type="button"
        class="filter-pill chooser-filter-chip"
        :class="{ active: activeFilter === chip.key }"
        @click="activeFilter = chip.key"
      >
        {{ t(chip.labelKey) }}
      </button>
    </div>

    <div
      v-if="installationStore.loading && nonCloudInstalls.length === 0"
      class="chooser-loading"
    >
      {{ t('common.loading') }}
    </div>

    <div v-else class="chooser-grid">
      <button
        type="button"
        class="chooser-tile chooser-tile-new"
        @click="handleNewInstallClick"
      >
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
</template>

<style scoped>
@import './chooser/chooser-tiles.css';

.chooser-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Layout-only — chip shape / hover / active live in `.filter-pill` (assets/main.css). */
.chooser-filters {
  padding: 16px 24px 8px;
  flex-shrink: 0;
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
  /* auto-fill + 1fr so tiles grow more columns on wide windows; on narrow
   * windows fewer columns appear and the grid scrolls vertically.
   * Min 320px keeps room for icon + name + pills. */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  padding: 8px 24px 24px;
  align-content: start;
}
</style>
