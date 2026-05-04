<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import { useSessionStore } from '../stores/sessionStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useInstallContextMenu } from '../composables/useInstallContextMenu'
import { Cloud, Clock, Pin, Box, Play } from 'lucide-vue-next'
import ContextMenu from '../components/ContextMenu.vue'
import type { Installation } from '../types/ipc'

/**
 * Chooser view (Phase 3 step 2 of the unified-window work).
 *
 * Replaces the standalone Dashboard + Installs surfaces with a single
 * "what install do I want to open right now" picker. Renderer-only —
 * the install-less host window in step 2c will host this as the Comfy
 * tab body when no install backs the entry.
 *
 * Layout per docs/unified-window-phase3-notes.md section 2:
 *   - Pinned Cloud promo row above the table (single row, not inside it)
 *   - Recent section sourced from lastLaunchedAt (descending)
 *   - All section listing every install
 *   - One scrollable view, both visible at once (NOT tabs)
 *   - No primary affordance (the primary system was retired in step 2a)
 */

const props = withDefaults(defineProps<{
  visible?: boolean
  /** Maximum number of recent installs to surface. */
  recentLimit?: number
}>(), {
  visible: true,
  recentLimit: 5,
})

const emit = defineEmits<{
  /** User picked an install — caller decides whether to swap-in-place,
   *  open a fresh window, or hand off to a launch flow. */
  pick: [installation: Installation]
  /** User triggered the new-install flow from the empty state. */
  'show-new-install': []
  /** User opened the install detail (View Details from the context menu). */
  'show-detail': [installation: Installation]
}>()

const installationStore = useInstallationStore()
const sessionStore = useSessionStore()
const prefs = useLauncherPrefs()

// installationStore auto-fetches on installations-changed, so we just
// need to kick the initial load.
onMounted(() => {
  if (installationStore.installations.length === 0) {
    installationStore.fetchInstallations()
  }
})

// --- Cloud promo row (pinned above the table, not inside it) ---
const cloudInstall = computed<Installation | null>(() =>
  installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null
)

// --- Non-cloud installs feed both Recent and All sections ---
const nonCloudInstalls = computed<Installation[]>(() =>
  installationStore.installations.filter((i) => i.sourceCategory !== 'cloud')
)

// --- Recent: top N non-cloud installs by lastLaunchedAt (descending) ---
const recentInstalls = computed<Installation[]>(() => {
  const withTimestamp = nonCloudInstalls.value.filter(
    (i) => typeof i.lastLaunchedAt === 'number'
  )
  withTimestamp.sort((a, b) => (b.lastLaunchedAt as number) - (a.lastLaunchedAt as number))
  return withTimestamp.slice(0, props.recentLimit)
})

// --- All: full non-cloud list (recent stays visible separately above) ---
const allInstalls = computed<Installation[]>(() => nonCloudInstalls.value)

const isEmpty = computed(() =>
  !cloudInstall.value && nonCloudInstalls.value.length === 0
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

// --- Context menu: pin/unpin/dismiss-error/view-details ---
const { ctxMenu, ctxMenuItems, openCardMenu, handleCtxMenuSelect, closeMenu } =
  useInstallContextMenu((inst) => emit('show-detail', inst))

// --- Row classes mirror the DashboardCard idle/running/stopping states ---
function rowClasses(inst: Installation): Record<string, boolean> {
  return {
    'chooser-row-running':
      sessionStore.isRunning(inst.id) && !sessionStore.isStopping(inst.id),
    'chooser-row-stopping': sessionStore.isStopping(inst.id),
    'chooser-row-in-progress':
      sessionStore.activeSessions.has(inst.id) && !sessionStore.isRunning(inst.id),
  }
}

function pick(inst: Installation): void {
  emit('pick', inst)
}
</script>

<template>
  <div v-show="visible" class="chooser-view">
    <div class="chooser-scroll">
      <!-- Cloud promo row (single pinned row above the table) -->
      <div
        v-if="cloudInstall"
        class="chooser-cloud-row"
        @click="pick(cloudInstall)"
        @contextmenu.prevent="openCardMenu($event, cloudInstall!)"
      >
        <div class="chooser-cloud-icon"><Cloud :size="22" /></div>
        <div class="chooser-cloud-text">
          <div class="chooser-cloud-title">{{ cloudInstall.name }}</div>
          <div class="chooser-cloud-desc">{{ $t('dashboard.cloudSection') }}</div>
        </div>
        <button class="primary chooser-cloud-cta" @click.stop="pick(cloudInstall!)">
          {{ $t('chooser.openCloud') }}
        </button>
      </div>

      <!-- Loading state -->
      <div v-if="installationStore.loading && allInstalls.length === 0" class="modal-loading with-spinner">
        {{ $t('common.loading') }}
      </div>

      <!-- Empty state — zero installs and no cloud either -->
      <div v-else-if="isEmpty" class="chooser-empty">
        <div class="chooser-empty-icon"><Box :size="48" /></div>
        <h1 class="chooser-empty-title">{{ $t('chooser.emptyTitle') }}</h1>
        <p class="chooser-empty-desc">{{ $t('chooser.emptyDesc') }}</p>
        <button class="primary" @click="emit('show-new-install')">
          {{ $t('chooser.createInstall') }}
        </button>
      </div>

      <!-- Recent section -->
      <div v-if="recentInstalls.length > 0" class="chooser-section">
        <div class="chooser-section-label">
          <Clock :size="14" />
          {{ $t('chooser.recent') }}
        </div>
        <div class="chooser-table">
          <div
            v-for="inst in recentInstalls"
            :key="`recent-${inst.id}`"
            class="chooser-row"
            :class="rowClasses(inst)"
            @click="pick(inst)"
            @contextmenu.prevent="openCardMenu($event, inst)"
          >
            <div class="chooser-row-name">
              {{ inst.name }}
              <Pin
                v-if="prefs.isPinned(inst.id)"
                :size="13"
                class="chooser-row-pin"
                :title="$t('dashboard.pinned')"
              />
            </div>
            <div class="chooser-row-meta">
              <span>{{ inst.sourceLabel }}</span>
              <template v-if="inst.version">
                <span> · </span><span>{{ inst.version }}</span>
              </template>
              <template v-if="typeof inst.lastLaunchedAt === 'number'">
                <span> · </span>
                <span>{{ $t('dashboard.launchedAgo', { time: timeAgo(inst.lastLaunchedAt as number) }) }}</span>
              </template>
            </div>
            <div class="chooser-row-actions">
              <Play :size="16" />
            </div>
          </div>
        </div>
      </div>

      <!-- All section -->
      <div v-if="allInstalls.length > 0" class="chooser-section">
        <div class="chooser-section-label">
          <Box :size="14" />
          {{ $t('chooser.all') }}
        </div>
        <div class="chooser-table">
          <div
            v-for="inst in allInstalls"
            :key="`all-${inst.id}`"
            class="chooser-row"
            :class="rowClasses(inst)"
            @click="pick(inst)"
            @contextmenu.prevent="openCardMenu($event, inst)"
          >
            <div class="chooser-row-name">
              {{ inst.name }}
              <Pin
                v-if="prefs.isPinned(inst.id)"
                :size="13"
                class="chooser-row-pin"
                :title="$t('dashboard.pinned')"
              />
            </div>
            <div class="chooser-row-meta">
              <span>{{ inst.sourceLabel }}</span>
              <template v-if="inst.version">
                <span> · </span><span>{{ inst.version }}</span>
              </template>
              <template v-if="typeof inst.lastLaunchedAt === 'number'">
                <span> · </span>
                <span>{{ $t('dashboard.launchedAgo', { time: timeAgo(inst.lastLaunchedAt as number) }) }}</span>
              </template>
              <template v-else>
                <span> · </span>
                <span>{{ $t('dashboard.neverLaunched') }}</span>
              </template>
            </div>
            <div class="chooser-row-actions">
              <Play :size="16" />
            </div>
          </div>
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

.chooser-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.chooser-cloud-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-radius: 10px;
  background: var(--bg-elev-1, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.18));
  cursor: pointer;
  transition: background 120ms ease;
}
.chooser-cloud-row:hover {
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
}
.chooser-cloud-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: var(--bg-elev-2, rgba(127, 127, 127, 0.14));
}
.chooser-cloud-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chooser-cloud-title {
  font-weight: 600;
}
.chooser-cloud-desc {
  font-size: 12px;
  opacity: 0.7;
}
.chooser-cloud-cta {
  flex-shrink: 0;
}

.chooser-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 24px;
  text-align: center;
}
.chooser-empty-icon {
  opacity: 0.5;
}
.chooser-empty-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
}
.chooser-empty-desc {
  margin: 0;
  opacity: 0.75;
  max-width: 420px;
}

.chooser-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chooser-section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.65;
  padding: 0 4px;
}

.chooser-table {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chooser-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 100ms ease;
  background: transparent;
}
.chooser-row:hover {
  background: var(--bg-elev-1, rgba(127, 127, 127, 0.08));
}
.chooser-row-running {
  box-shadow: inset 0 0 0 1px var(--accent-success, #2e7d32);
}
.chooser-row-stopping,
.chooser-row-in-progress {
  opacity: 0.7;
}

.chooser-row-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
}
.chooser-row-pin {
  opacity: 0.6;
}
.chooser-row-meta {
  font-size: 12px;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chooser-row-actions {
  display: flex;
  align-items: center;
  opacity: 0.5;
}
.chooser-row:hover .chooser-row-actions {
  opacity: 1;
}
</style>
