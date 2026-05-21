<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Play, RefreshCcw, TriangleAlert, Loader2, ArrowLeft } from 'lucide-vue-next'
import { useSessionStore } from '../stores/sessionStore'
import { useReturnToDashboardConfirm } from '../composables/useReturnToDashboardConfirm'
import { emitTelemetryAction } from '../lib/telemetry'
import BaseCopyButton from '../components/ui/BaseCopyButton.vue'
import type { Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Body view for the Comfy tab when no ComfyUI process is currently running
 * inside the host window. Driven entirely by sessionStore so the user sees
 * the right transient state when:
 *   - the install is starting up after a re-launch
 *   - the launcher is shutting it down (e.g. a REQUIRES_STOPPED action is
 *     in flight)
 *   - the process crashed and main left the window alive
 *   - it's plain stopped (initial state, or user chose Stop)
 *
 * Re-launching is the panel's own responsibility — clicking the start button
 * surfaces the standard ProgressModal flow via the parent PanelApp's
 * `show-progress` emit, mirroring how DashboardCard / DetailModal kick off
 * the same action.
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
  { immediate: true },
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
      lastStderr: data.lastStderr,
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
  },
)

const installationName = computed(() => props.installation?.name ?? '')

function startLaunch(): void {
  if (!props.installationId) return
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
    opKind: 'launch',
  })
}

const { confirmReturnToDashboard } = useReturnToDashboardConfirm()

async function returnToDashboard(): Promise<void> {
  const id = props.installationId
  // confirmReturnToDashboard is a no-op for stopped / crashed states; only the
  // brief running-but-lifecycle-mounted window actually triggers the prompt.
  const isRunning = id ? sessionStore.isRunning(id) : false
  const reason = isRunning ? 'running' : state.value === 'crashed' ? 'crashed' : 'stopped'
  const ok = await confirmReturnToDashboard(props.installation, reason)
  if (!ok) return
  emitTelemetryAction('desktop2.instance.return_to_dashboard', { from: 'lifecycle', reason })
  await window.api.returnToDashboard()
}
</script>

<template>
  <div class="lifecycle-view">
    <!-- `unknown` = pre-hydration. The card is hidden for the first
         `UNKNOWN_PLACEHOLDER_GRACE_MS` so a fast `sessionStore.init()`
         (the common case) doesn't flash the stopped card before the
         real state lands. If hydration drags past that grace window
         we render a minimal spinning placeholder so the user never
         stares at a bare grey panel — that was the "screen turns
         into a grey window" regression. -->
    <div
      v-if="state === 'unknown' && showUnknownPlaceholder"
      class="lifecycle-card"
      data-state="unknown"
    >
      <div class="lifecycle-icon spin">
        <Loader2 :size="32" />
      </div>
      <h2>{{ $t('comfyLifecycle.preparingTitle') }}</h2>
    </div>

    <div v-else-if="state !== 'running' && state !== 'unknown'" class="lifecycle-card" :data-state="state">
      <template v-if="state === 'launching'">
        <div class="lifecycle-icon spin">
          <Loader2 :size="32" />
        </div>
        <h2>{{ $t('comfyLifecycle.launchingTitle') }}</h2>
        <p>{{ $t('comfyLifecycle.launchingDesc') }}</p>
      </template>

      <template v-else-if="state === 'stopping'">
        <div class="lifecycle-icon spin">
          <Loader2 :size="32" />
        </div>
        <h2>{{ $t('comfyLifecycle.stoppingTitle') }}</h2>
        <p>{{ $t('comfyLifecycle.stoppingDesc') }}</p>
      </template>

      <template v-else-if="state === 'crashed'">
        <div class="lifecycle-icon danger">
          <TriangleAlert :size="32" />
        </div>
        <h2>{{ $t('comfyLifecycle.crashedTitle') }}</h2>
        <p v-if="errorInfo?.exitCode != null">
          {{ $t('comfyLifecycle.crashedDescWithCode', { code: errorInfo.exitCode }) }}
        </p>
        <p v-else>{{ $t('comfyLifecycle.crashedDesc') }}</p>
        <details v-if="errorInfo?.lastStderr" class="lifecycle-error-detail">
          <summary class="lifecycle-error-summary">
            <span>{{ $t('comfyLifecycle.crashedDetailsToggle') }}</span>
            <BaseCopyButton
              :value="errorInfo.lastStderr"
              :aria-label="$t('common.copy')"
              class="lifecycle-error-copy"
              @click.stop.prevent
            />
          </summary>
          <pre class="lifecycle-error-output">{{ errorInfo.lastStderr }}</pre>
        </details>
        <div class="lifecycle-actions">
          <button class="primary" type="button" @click="startLaunch">
            <RefreshCcw :size="16" />
            {{ $t('comfyLifecycle.restart') }}
          </button>
          <button class="secondary" type="button" @click="returnToDashboard">
            <ArrowLeft :size="16" />
            {{ $t('comfyLifecycle.returnToDashboard') }}
          </button>
        </div>
      </template>

      <template v-else>
        <div class="lifecycle-icon">
          <Play :size="32" />
        </div>
        <h2>{{ $t('comfyLifecycle.stoppedTitle') }}</h2>
        <p>{{ $t('comfyLifecycle.stoppedDesc') }}</p>
        <div class="lifecycle-actions">
          <button class="primary" type="button" @click="startLaunch">
            <Play :size="16" />
            {{ $t('comfyLifecycle.start') }}
          </button>
          <button class="secondary" type="button" @click="returnToDashboard">
            <ArrowLeft :size="16" />
            {{ $t('comfyLifecycle.returnToDashboard') }}
          </button>
        </div>
      </template>
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

.lifecycle-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  text-align: center;
  max-width: 480px;
  padding: 28px 32px;
}

.lifecycle-card h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.lifecycle-card p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.5;
}

.lifecycle-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
}

.lifecycle-icon.danger {
  color: var(--danger, #d97357);
  border-color: var(--danger, #d97357);
}

.lifecycle-icon.spin {
  color: var(--accent, #4d8eff);
}

.lifecycle-icon.spin :deep(svg) {
  animation: lifecycle-spin 1s linear infinite;
}

@keyframes lifecycle-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.lifecycle-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.lifecycle-actions button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.lifecycle-error-detail {
  width: 100%;
  max-width: 100%;
  text-align: left;
  margin-top: 4px;
}

.lifecycle-error-detail summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 0;
  user-select: none;
  text-align: center;
}

.lifecycle-error-detail summary:hover {
  color: var(--text);
}

/* Summary row hosting the label + an inline Copy button. Flex so the
   copy affordance sits to the right without affecting the disclosure
   triangle. The button stops click propagation so tapping it doesn't
   toggle the <details> open/closed state. */
.lifecycle-error-summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.lifecycle-error-copy {
  margin-left: 2px;
}

.lifecycle-error-output {
  margin: 8px 0 0;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
  text-align: left;
  /* Selectable so users can copy the stderr tail manually as a
     fallback to the inline Copy button — important for the
     paste-into-issue-thread flow. */
  user-select: text;
  -webkit-user-select: text;
}
</style>
