<script setup lang="ts">
/**
 * Phase 3 §17 Step 4 — first-use takeover.
 *
 * Multi-step Tier 3 takeover that runs the first time the launcher
 * starts (or any subsequent launch where `launcherPrefs.firstUseCompleted`
 * is still false because the user dismissed mid-flow). Mounts in
 * PanelApp's overlay slot just like the four flow modals — see
 * `openFirstUseTakeover` for the host-side wiring.
 *
 * Step ordering:
 *   1. `consent` — T&C acknowledgement + telemetry consent toggle on a
 *                  single page. Accept-T&C button advances.
 *   2. `mirrors` — Only inserted when the resolved locale starts with
 *                  'zh'. Reuses the existing `chineseMirrorsSuggest*`
 *                  copy in en/zh + the `useChineseMirrors` setting; we
 *                  flip the global flag through `setSetting`, no new
 *                  per-source override surface yet (Step 5+ territory).
 *                  `chineseMirrorsPrompted` is also set so the legacy
 *                  prompt machinery doesn't re-fire later.
 *   3. `pick`    — Cloud-vs-Local card picker. Cloud emits `complete`
 *                  immediately (the chooser body underneath is what the
 *                  user lands on, where they can pick the cloud install
 *                  to launch). Local emits `chain-local` so the host
 *                  swaps this takeover for the new-install Tier 3
 *                  takeover (Tier 3 → Tier 3 swap is silent in
 *                  `useOverlay`); the host then marks completion when
 *                  new-install ends successfully.
 *
 * The takeover stays a pure stepper — it does NOT call `setSetting`
 * for `firstUseCompleted` itself; the host owns that flip so the
 * Local-branch chain (which finishes outside this component) can mark
 * complete consistently.
 *
 * `open()` resets all internal state to step 1 and re-fetches the
 * locale; the host calls it post-mount the same way the flow modals
 * are reset.
 */
import { ref, computed, onMounted } from 'vue'

type Step = 'consent' | 'mirrors' | 'pick'

const emit = defineEmits<{
  /** User dismissed mid-flow (✕ / Escape). Host should NOT mark
   *  `firstUseCompleted` — the takeover replays on the next launch. */
  close: []
  /** Cloud branch picked, or Local branch finished — host should flip
   *  `firstUseCompleted` and close the takeover. */
  complete: []
  /** Local branch picked — host should chain into the new-install
   *  Tier 3 takeover (Tier 3 → Tier 3 swap is silent) and mark
   *  `firstUseCompleted` once new-install ends successfully. */
  'chain-local': []
}>()

const step = ref<Step>('consent')
const telemetryEnabled = ref(true)
const locale = ref('en')

const isChinese = computed(() => locale.value.startsWith('zh'))

/** Step 1 → next: telemetry persists immediately so a mid-flow cancel
 *  still respects the user's choice (the `firstUseCompleted` gate is
 *  separate — re-running the takeover surfaces the toggle in its
 *  current persisted state, not as a freshly-defaulted opt-in). */
async function acceptConsent(): Promise<void> {
  await window.api.setSetting('telemetryEnabled', telemetryEnabled.value)
  step.value = isChinese.value ? 'mirrors' : 'pick'
}

/** Step 2 — the China-mirror prompt always advances regardless of
 *  the user's pick; only the persisted `useChineseMirrors` flag
 *  differs. `chineseMirrorsPrompted` is set in both branches so the
 *  legacy `suggest-chinese-mirrors` listener won't re-fire later. */
async function chooseMirrors(useMirrors: boolean): Promise<void> {
  await Promise.all([
    window.api.setSetting('useChineseMirrors', useMirrors),
    window.api.setSetting('chineseMirrorsPrompted', true),
  ])
  step.value = 'pick'
}

function pickCloud(): void {
  emit('complete')
}

function pickLocal(): void {
  emit('chain-local')
}

async function open(): Promise<void> {
  step.value = 'consent'
  // Pre-load existing telemetry preference so the toggle reflects the
  // user's current persisted choice if the takeover is replaying after
  // a mid-flow cancel (the consent step is the only one that can flip
  // a destructive default).
  const existing = await window.api.getSetting('telemetryEnabled') as boolean | undefined
  telemetryEnabled.value = existing !== false
  locale.value = await window.api.getLocale().catch(() => 'en')
}

onMounted(() => {
  // Initial mount path — host's `openFirstUseTakeover` calls open()
  // post-mount for the reset, but the auto-mount on PanelApp.onMounted
  // (when `firstUseCompleted === false`) goes through openOverlay
  // before nextTick, so we still need a baseline locale fetch here.
  void open()
})

defineExpose({ open })
</script>

<template>
  <div class="view-modal-content first-use-takeover">
    <div class="view-modal-header">
      <div class="view-modal-title">{{ $t('firstUse.title') }}</div>
      <button class="view-modal-close" @click="emit('close')">✕</button>
    </div>
    <div class="view-modal-body">
      <div class="view-scroll">
        <!-- Step 1: T&C + telemetry consent -->
        <template v-if="step === 'consent'">
          <p class="first-use-lead">{{ $t('firstUse.consentLead') }}</p>
          <p class="first-use-tos">
            {{ $t('firstUse.tosBody') }}
          </p>
          <label class="first-use-toggle">
            <input v-model="telemetryEnabled" type="checkbox" />
            <span>{{ $t('settings.telemetryEnabled') }}</span>
          </label>
          <p class="first-use-hint">{{ $t('firstUse.telemetryHint') }}</p>
        </template>

        <!-- Step 2: China mirror prompt (only when locale starts with 'zh') -->
        <template v-else-if="step === 'mirrors'">
          <h3 class="first-use-step-title">{{ $t('settings.chineseMirrorsSuggestTitle') }}</h3>
          <p class="first-use-lead">{{ $t('settings.chineseMirrorsSuggestMessage') }}</p>
        </template>

        <!-- Step 3: Cloud vs Local picker -->
        <template v-else-if="step === 'pick'">
          <h3 class="first-use-step-title">{{ $t('firstUse.pickTitle') }}</h3>
          <p class="first-use-lead">{{ $t('firstUse.pickLead') }}</p>
          <div class="first-use-cards">
            <button
              class="first-use-card"
              data-testid="first-use-pick-cloud"
              @click="pickCloud"
            >
              <div class="first-use-card-title">{{ $t('cloud.label') }}</div>
              <div class="first-use-card-desc">{{ $t('cloud.desc') }}</div>
            </button>
            <button
              class="first-use-card"
              data-testid="first-use-pick-local"
              @click="pickLocal"
            >
              <div class="first-use-card-title">{{ $t('firstUse.localLabel') }}</div>
              <div class="first-use-card-desc">{{ $t('firstUse.localDesc') }}</div>
            </button>
          </div>
        </template>
      </div>

      <div class="wizard-footer">
        <div class="wizard-back-placeholder"></div>
        <div></div>
        <template v-if="step === 'consent'">
          <button
            class="primary"
            data-testid="first-use-accept-consent"
            @click="acceptConsent"
          >
            {{ $t('firstUse.acceptTos') }}
          </button>
        </template>
        <template v-else-if="step === 'mirrors'">
          <div class="first-use-mirror-buttons">
            <button
              class="secondary"
              data-testid="first-use-mirrors-skip"
              @click="chooseMirrors(false)"
            >
              {{ $t('firstUse.notNow') }}
            </button>
            <button
              class="primary"
              data-testid="first-use-mirrors-accept"
              @click="chooseMirrors(true)"
            >
              {{ $t('settings.chineseMirrorsSuggestConfirm') }}
            </button>
          </div>
        </template>
        <template v-else>
          <div></div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.first-use-takeover {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.first-use-lead {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text);
  margin-bottom: 12px;
}

.first-use-tos {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
  margin-bottom: 20px;
  white-space: pre-wrap;
}

.first-use-step-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px 0;
  color: var(--text);
}

.first-use-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: var(--text);
  margin-top: 12px;
}

.first-use-hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
  margin-top: 8px;
}

.first-use-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.first-use-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease;
}

.first-use-card:hover {
  border-color: var(--accent);
  background: var(--surface-hover, var(--surface));
}

.first-use-card-title {
  font-size: 16px;
  font-weight: 600;
}

.first-use-card-desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
}

.first-use-mirror-buttons {
  display: flex;
  gap: 8px;
}
</style>
