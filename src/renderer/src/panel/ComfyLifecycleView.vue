<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCcw, Loader2, ArrowLeft } from 'lucide-vue-next'
import { useSessionStore } from '../stores/sessionStore'
import { useReturnToDashboardConfirm } from '../composables/useReturnToDashboardConfirm'
import { emitTelemetryAction } from '../lib/telemetry'
import BrandFinishedSurface from '../components/BrandFinishedSurface.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Body view for the Comfy tab when no ComfyUI process is currently
 * running inside the host window. Exists to keep the host window alive
 * after a crash so the user has somewhere to view the failure context,
 * return to the dashboard, or restart ComfyUI.
 *
 * Driven entirely by sessionStore:
 *   - `crashed` → renders the shared brand-error takeover via
 *     BrandFinishedSurface (mirrors ProgressModal's error finished
 *     state so the surface reads identically whether the user is
 *     still looking at the in-flight modal or has reopened the panel
 *     afterwards).
 *   - `launching` / `stopping` → renders the small spinner placeholder
 *     as a safety net for the narrow race window where the in-flight
 *     ProgressModal hasn't mounted yet.
 *   - `unknown` → hidden behind a brief grace window so a fast
 *     `sessionStore.init()` doesn't flash anything.
 *   - everything else (`running`, fallback) → renders nothing; the
 *     host's ComfyUI view covers the panel.
 *
 * Restart surfaces the standard ProgressModal flow via the parent
 * PanelApp's `show-progress` emit, mirroring how DashboardCard /
 * DetailModal kick off the same action.
 */

interface Props {
  installation: Installation | null
  installationId: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  'show-progress': [opts: ShowProgressOpts]
}>()

const { t } = useI18n()
const sessionStore = useSessionStore()

type LifecycleState = 'running' | 'launching' | 'stopping' | 'crashed' | 'stopped' | 'unknown'

const state = computed<LifecycleState>(() => {
  // 'unknown' = sessionStore hasn't hydrated yet. The template renders
  // nothing for this branch so we don't flash the stopped card before
  // the first init() reports whether something is already running.
  if (!sessionStore.ready) return 'unknown'
  const id = props.installationId
  if (sessionStore.isRunning(id)) return 'running'
  if (sessionStore.isLaunching(id)) return 'launching'
  if (sessionStore.isStopping(id)) return 'stopping'
  if (sessionStore.errorInstances.has(id)) return 'crashed'
  return 'stopped'
})

const errorInfo = computed(() => sessionStore.errorInstances.get(props.installationId) ?? null)

const crashedLogs = computed<string | null>(() => {
  if (state.value !== 'crashed') return null
  return errorInfo.value?.lastStderr ?? null
})

const crashedMessage = computed<string | null>(() => {
  if (state.value !== 'crashed') return null
  // Pick the most specific phrasing for whatever main captured. Signal +
  // code (POSIX kill paths) is the richest; signal alone covers exits
  // where Node reported only the signal; code alone is the Windows /
  // non-zero-exit path; falling all the way through means we got neither
  // and only have "something exited".
  const code = errorInfo.value?.exitCode
  const signal = errorInfo.value?.signal
  let base: string
  if (signal && code != null) {
    base = t('comfyLifecycle.crashedDescWithCodeAndSignal', { code, signal })
  } else if (signal) {
    base = t('comfyLifecycle.crashedDescWithSignal', { signal })
  } else if (code != null) {
    base = t('comfyLifecycle.crashedDescWithCode', { code })
  } else {
    base = t('comfyLifecycle.crashedDesc')
  }
  // Append the logs hint only when we actually have stderr to show — the
  // hint would otherwise point at a logs accordion that isn't rendered.
  if (crashedLogs.value) {
    return `${base} ${t('comfyLifecycle.crashedDescLogsHint')}`
  }
  return base
})

/**
 * Grey-window guard — the original `state === 'unknown'` branch
 * rendered nothing so a fast hydration (the common case) wouldn't
 * flash a stopped card. But on a slow init the user saw a bare grey
 * panel with no indication anything was loading. This ref flips to
 * true if hydration takes longer than `UNKNOWN_PLACEHOLDER_GRACE_MS`,
 * which is enough to skip the visible card on every normal load but
 * surface a small spinning placeholder when something's genuinely
 * stuck. Reset whenever sessionStore re-enters the unknown state
 * (e.g. across an install swap).
 */
const UNKNOWN_PLACEHOLDER_GRACE_MS = 150
const showUnknownPlaceholder = ref(false)
let unknownGraceTimer: ReturnType<typeof setTimeout> | null = null

function clearUnknownGraceTimer(): void {
  if (unknownGraceTimer) {
    clearTimeout(unknownGraceTimer)
    unknownGraceTimer = null
  }
}

watch(
  () => state.value === 'unknown',
  (isUnknown) => {
    clearUnknownGraceTimer()
    if (!isUnknown) {
      showUnknownPlaceholder.value = false
      return
    }
    unknownGraceTimer = setTimeout(() => {
      showUnknownPlaceholder.value = true
      unknownGraceTimer = null
    }, UNKNOWN_PLACEHOLDER_GRACE_MS)
  },
  { immediate: true }
)

onBeforeUnmount(clearUnknownGraceTimer)

/**
 * Hydrate the session-store error map from main's retained crash buffer
 * for this install. Covers the case where the panel WebContents was
 * recreated (refresh, body-mode swap back to lifecycle, second window
 * opened on the same install) AFTER the live `comfy-exited` event fired
 * — without this fetch the renderer would land on the lifecycle view
 * with no error context to render. Triggered on mount and whenever the
 * targeted install changes; the live IPC handler in sessionStore keeps
 * the map fresh for crashes that happen while the view is alive.
 */
async function hydrateLastCrashError(installationId: string): Promise<void> {
  if (!installationId) return
  // Skip when the live event already populated the map for this install —
  // the renderer copy is the freshest source of truth.
  if (sessionStore.errorInstances.has(installationId)) return
  try {
    const data = await window.api.getLastCrashError(installationId)
    if (!data || !data.crashed) return
    if (sessionStore.errorInstances.has(installationId)) return
    sessionStore.errorInstances.set(installationId, {
      installationName: data.installationName,
      exitCode: data.exitCode,
      signal: data.signal,
      lastStderr: data.lastStderr,
      // Carry the main-side crash timestamp so
      // `comfy.desktop.instance.relaunched_after_crash` can compute a real
      // `crash_to_relaunch_seconds` even when this view hydrated AFTER
      // the live `comfy-exited` event (panel recreated, etc.).
      crashedAtMs: data.crashedAtMs
    })
  } catch {
    // Best-effort — a missing handler / IPC failure shouldn't break the view.
  }
}

onMounted(() => {
  void hydrateLastCrashError(props.installationId)
})

watch(
  () => props.installationId,
  (id) => {
    void hydrateLastCrashError(id)
  }
)

const installationName = computed(() => props.installation?.name ?? '')

function startLaunch(): void {
  if (!props.installationId) return
  // Capture the recovery half of the lifecycle-resilience question: the
  // crash itself fires from main (`comfyui.exited` with crashed=true);
  // this complements it with "did the user actually re-launch after the
  // crash?" plus the crash-to-relaunch wall clock.
  if (state.value === 'crashed') {
    const errorInfoSnapshot = sessionStore.errorInstances.get(props.installationId)
    const crashedAtMs = errorInfoSnapshot?.crashedAtMs
    emitTelemetryAction('comfy.desktop.instance.relaunched_after_crash', {
      installation_id: props.installationId,
      crash_to_relaunch_seconds:
        crashedAtMs != null ? Math.round((Date.now() - crashedAtMs) / 1000) : null
    })
  }
  // The progress modal owns the launch lifecycle (start, status, port-conflict
  // resolution, cancel). Once the instance reaches 'started', main swaps the
  // body back to the live ComfyUI view automatically.
  emit('show-progress', {
    installationId: props.installationId,
    title: installationName.value
      ? `${t('comfyLifecycle.launchProgressTitle')} — ${installationName.value}`
      : t('comfyLifecycle.launchProgressTitle'),
    apiCall: () => window.api.runAction(props.installationId, 'launch'),
    cancellable: true,
    opKind: 'launch'
  })
}

const { confirmReturnToDashboard } = useReturnToDashboardConfirm()

async function returnToDashboard(): Promise<void> {
  const id = props.installationId
  // confirmReturnToDashboard is a no-op for the crashed surface; only the
  // brief running-but-lifecycle-mounted race window actually triggers the
  // prompt.
  const isRunning = id ? sessionStore.isRunning(id) : false
  const reason = isRunning ? 'running' : 'crashed'
  const ok = await confirmReturnToDashboard(props.installation, reason)
  if (!ok) return
  emitTelemetryAction('comfy.desktop.instance.return_to_dashboard', { from: 'lifecycle', reason })
  await window.api.returnToDashboard()
}

// Show the small placeholder spinner for the in-flight (`launching` /
// `stopping`) states too — ProgressModal owns those flows via its own
// brand takeover, so this only renders during the brief race window
// where the session-store flag is set but ProgressModal hasn't
// mounted yet (e.g. externally-triggered stop).
const showPlaceholder = computed<boolean>(() => {
  if (state.value === 'unknown') return showUnknownPlaceholder.value
  return state.value === 'launching' || state.value === 'stopping'
})

const placeholderTitle = computed<string>(() => {
  if (state.value === 'launching') return t('comfyLifecycle.launchingTitle')
  if (state.value === 'stopping') return t('comfyLifecycle.stoppingTitle')
  return t('comfyLifecycle.preparingTitle')
})
</script>

<template>
  <div class="lifecycle-view">
    <!-- Crashed → keep the host window alive after ComfyUI exits
         unexpectedly so the user has somewhere to view logs, return to
         the dashboard, or restart. Matches ProgressModal's error
         finished state visually — see BrandFinishedSurface for the
         shared chrome. -->
    <BrandFinishedSurface
      v-if="state === 'crashed'"
      :title="$t('comfyLifecycle.crashedTitle')"
      :message="crashedMessage ?? undefined"
      :logs="crashedLogs ?? undefined"
      :aria-label="$t('comfyLifecycle.crashedTitle')"
    >
      <template #actions>
        <button
          class="brand-ghost brand-progress__footer-btn"
          type="button"
          @click="returnToDashboard"
        >
          <ArrowLeft :size="14" />
          {{ $t('common.back') }}
        </button>
        <button class="brand-primary brand-progress__footer-btn" type="button" @click="startLaunch">
          <RefreshCcw :size="14" />
          {{ $t('comfyLifecycle.restart') }}
        </button>
      </template>
    </BrandFinishedSurface>

    <!-- Pre-hydration + in-flight (launching / stopping) placeholder.
         ProgressModal owns the launching / stopping takeover when its
         op is live; this is only the safety-net spinner for the
         narrow race window where the session-store flag is set but
         no ProgressModal is mounted. Hidden until the unknown grace
         window lapses so a fast `sessionStore.init()` (the common
         case) doesn't flash anything. -->
    <div v-else-if="showPlaceholder" class="lifecycle-placeholder" data-state="placeholder">
      <div class="lifecycle-placeholder__icon">
        <Loader2 :size="32" />
      </div>
      <h2>{{ placeholderTitle }}</h2>
    </div>
  </div>
</template>

<style scoped>
.lifecycle-view {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg);
  color: var(--text);
}

/* Pre-hydration / race-window placeholder. The brand-finished surface
 * is teleported to body and covers the panel viewport; this is the
 * only branch that stays inline. */
.lifecycle-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  max-width: 480px;
  padding: 28px 32px;
}
.lifecycle-placeholder h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.lifecycle-placeholder__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--accent, #4d8eff);
}
.lifecycle-placeholder__icon :deep(svg) {
  animation: lifecycle-spin 1s linear infinite;
}
@keyframes lifecycle-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
