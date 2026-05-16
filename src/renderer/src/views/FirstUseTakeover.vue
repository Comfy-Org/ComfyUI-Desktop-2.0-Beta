<script setup lang="ts">
/**
 * First-use takeover.
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
 *                  per-source override surface yet.
 *                  `chineseMirrorsPrompted` is also set so the
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
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { Check, Copy, FolderInput, Info } from 'lucide-vue-next'
import TakeoverHeader from '../components/TakeoverHeader.vue'
import ModalShell from '../components/ModalShell.vue'
import ChoiceCard from '../components/ChoiceCard.vue'
import WhyTryCloudModal from '../components/WhyTryCloudModal.vue'
import TermsModal from '../components/TermsModal.vue'
import BrandTakeoverLayout from '../components/BrandTakeoverLayout.vue'
import ComfyWordmark from '../components/icons/ComfyWordmark.vue'
import { emitTelemetryAction } from '../lib/telemetry'

type Step = 'consent' | 'mirrors' | 'pick' | 'localBranch' | 'nameInstall'

const emit = defineEmits<{
  /** Cloud branch explicitly picked at the cloud-vs-local fork. Host
   *  marks `firstUseCompleted`, closes the takeover, and auto-launches
   *  the seeded Cloud install — the user asked for it. */
  'complete-cloud': []
  /** Returning user — `skipPick` was true so the cloud-vs-local fork
   *  was suppressed entirely. Host marks `firstUseCompleted` and
   *  closes the takeover, dropping the user on the chooser body where
   *  they can pick whichever existing install they want. NO implicit
   *  cloud launch — they didn't ask for it. */
  'complete-skip': []
  /** Local branch picked — host should chain into the new-install
   *  Tier 3 takeover (Tier 3 → Tier 3 swap is silent) and mark
   *  `firstUseCompleted` once new-install ends successfully. Naming
   *  happens inline on the Configure screen now. The optional payload
   *  flags whether the chain was reached via the Local → Start Fresh
   *  sub-step (vs. the direct no-legacy path) so the Configure screen
   *  can surface a Back link to return the user to localBranch. */
  'chain-local': [payload?: { cameFromLocalBranch?: boolean }]
  /** Local-branch follow-up: a Legacy Desktop install was detected
   *  and the user chose to migrate it instead of installing fresh.
   *  Host runs the migration flow (`useMigrateAction.confirmMigration`
   *  → `runAction('migrate-to-standalone', …)` via `show-progress`)
   *  on the auto-tracked desktop install and marks `firstUseCompleted`
   *  once the migration finishes successfully. Same shape as
   *  `chain-local` — host owns completion + auto-launch. */
  'chain-migrate': []
}>()

const step = ref<Step>('consent')
const telemetryEnabled = ref(true)
const locale = ref('en')
/** Funnel-completion bookkeeping for `desktop2.first_use.completed`.
 *  `mountedAt` is reset in `open()` so a takeover replay measures
 *  duration from the replay, not from the original mount.
 *  `stepsSeen` is a Set so re-visiting a step (back-navigation, replay)
 *  doesn't double-count. */
let mountedAt = Date.now()
const stepsSeen = new Set<Step>()
let completedFired = false

function emitCompleted(exitPath: 'cloud' | 'local-new' | 'local-migrate' | 'skipped'): void {
  if (completedFired) return
  completedFired = true
  emitTelemetryAction('desktop2.first_use.completed', {
    exit_path: exitPath,
    steps_seen: stepsSeen.size,
    duration_ms: Date.now() - mountedAt
  })
}
/** When the host detects prior usage of the launcher (any
 *  non-cloud, non-legacy-desktop install present), the
 *  cloud-vs-local pick step is suppressed: the user's already made
 *  the choice, no need to re-litigate. The takeover stops at consent
 *  (and the optional China-mirror sub-step) and emits `complete`
 *  instead of advancing to `pick`. Detection lives in main —
 *  `window.api.getFirstUseState()` — and is plumbed in via `open()`. */
const skipPick = ref(false)
/** When a Legacy Desktop install is detected on the machine
 *  (auto-tracked at startup as `sourceId === 'desktop'`),
 *  picking Local opens a follow-up sub-step where the user picks
 *  Migrate vs Install-new instead of immediately chaining into the
 *  new-install takeover. Detection lives in main; the host plumbs the
 *  flag in via `open()`. */
const hasLegacyDesktop = ref(false)
const whyCloudOpen = ref(false)
const termsOpen = ref(false)
/** Required acceptance of the Terms of Service / Privacy Policy. The
 *  primary "Get Started" CTA stays disabled until this flips true. The
 *  telemetry checkbox is a separate, optional opt-in (see
 *  `telemetryEnabled`). */
const acceptedTos = ref(false)
// TODO(brand-cleanup): nameInstall step merged into Configure screen —
// remove these refs after reviewer sign-off.
// const installName = ref('')
// const nameInstallInput = ref<HTMLInputElement | null>(null)

const isChinese = computed(() => locale.value.startsWith('zh'))

/** Steps that render inside the shared `BrandTakeoverLayout`. Sharing
 *  a single chrome instance across these steps means the takeover
 *  entrance animation plays once on overlay open, not on every internal
 *  step swap. Mirrors still ships as `ModalShell` until it gets the
 *  brand treatment too. */
const isBrandStep = computed(
  () =>
    step.value === 'consent' ||
    step.value === 'pick' ||
    step.value === 'localBranch'
)

/** Cancel on the consent step closes the host window. The figma's
 *  Cancel affordance maps to the standard desktop-app "Decline"
 *  pattern — user opted out of T&Cs, so we don't persist anything
 *  (telemetry pref stays at its prior value; `firstUseCompleted`
 *  stays false so the consent step re-surfaces on next launch). */
function cancelConsent(): void {
  emitTelemetryAction('desktop2.first_use.consent_decision', {
    decision: 'cancel',
    telemetry_enabled: telemetryEnabled.value,
    locale: locale.value
  })
  void window.api.closeHostWindow()
}

/** Step 1 → next: telemetry persists immediately so a mid-flow cancel
 *  still respects the user's choice (the `firstUseCompleted` gate is
 *  separate — re-running the takeover surfaces the toggle in its
 *  current persisted state, not as a freshly-defaulted opt-in). */
async function acceptConsent(): Promise<void> {
  await window.api.setSetting('telemetryEnabled', telemetryEnabled.value)
  // `consent_decision` (not `consent_accepted`) because this fires for
  // both opt-in and opt-out — the `decision` prop says which one.
  emitTelemetryAction('desktop2.first_use.consent_decision', {
    decision: telemetryEnabled.value ? 'accept' : 'decline',
    telemetry_enabled: telemetryEnabled.value,
    locale: locale.value
  })
  // skipPick suppresses the pick step entirely. China-mirror sub-step
  // still runs first when the locale calls for it, then the takeover
  // emits `complete-skip` (returning user — no implicit cloud launch)
  // instead of advancing to `pick`.
  if (isChinese.value) {
    step.value = 'mirrors'
  } else if (skipPick.value) {
    emitCompleted('skipped')
    emit('complete-skip')
  } else {
    step.value = 'pick'
  }
}

/** Step 2 — the China-mirror prompt always advances regardless of
 *  the user's pick; only the persisted `useChineseMirrors` flag
 *  differs. `chineseMirrorsPrompted` is set in both branches so the
 *  `suggest-chinese-mirrors` listener won't re-fire later. */
async function chooseMirrors(useMirrors: boolean): Promise<void> {
  await Promise.all([
    window.api.setSetting('useChineseMirrors', useMirrors),
    window.api.setSetting('chineseMirrorsPrompted', true)
  ])
  emitTelemetryAction('desktop2.first_use.mirrors_chosen', { use_mirrors: useMirrors })
  if (skipPick.value) {
    emitCompleted('skipped')
    emit('complete-skip')
  } else {
    step.value = 'pick'
  }
}

function pickCloud(): void {
  emitTelemetryAction('desktop2.first_use.fork_chosen', {
    choice: 'cloud',
    has_legacy_desktop: hasLegacyDesktop.value
  })
  emitCompleted('cloud')
  emit('complete-cloud')
}

/** Local branch — when a Legacy Desktop install is on the machine
 *  the user gets a Migrate-vs-Install-new sub-step before the chain
 *  fires; otherwise we go straight to the new-install chain.
 *  Detection (`hasLegacyDesktop`) is computed by main and plumbed in
 *  via `open()`. */
function pickLocal(): void {
  emitTelemetryAction('desktop2.first_use.fork_chosen', {
    choice: 'local',
    has_legacy_desktop: hasLegacyDesktop.value
  })
  if (hasLegacyDesktop.value) {
    step.value = 'localBranch'
  } else {
    emitCompleted('local-new')
    emit('chain-local')
  }
}

function openWhyCloud(): void {
  whyCloudOpen.value = true
  emitTelemetryAction('desktop2.first_use.why_cloud_opened', {})
}

function dismissWhyCloud(action: 'maybe_later' | 'dismiss'): void {
  whyCloudOpen.value = false
  emitTelemetryAction('desktop2.first_use.why_cloud_action', { action })
}

function onWhyCloudTryCloud(): void {
  whyCloudOpen.value = false
  emitTelemetryAction('desktop2.first_use.why_cloud_action', { action: 'try_cloud' })
  pickCloud()
}

function chooseMigrate(): void {
  emitTelemetryAction('desktop2.first_use.local_branch_chosen', { choice: 'migrate' })
  emitCompleted('local-migrate')
  emit('chain-migrate')
}

function chooseInstallNew(): void {
  emitTelemetryAction('desktop2.first_use.local_branch_chosen', { choice: 'install_new' })
  // Skip the dedicated name screen — naming now happens inline on the
  // Configure screen (NewInstallModal brand-config). Flag the origin so
  // Configure surfaces a Back link returning to localBranch.
  emitCompleted('local-new')
  emit('chain-local', { cameFromLocalBranch: true })
}

// TODO(brand-cleanup): name-install step merged into the Configure
// screen. `confirmInstallName` / `backFromNameInstall` / `installName` /
// `nameInstallInput` / the `nameInstall` step branch / its auto-focus
// watcher are kept commented below for one review cycle, then removed.
// function confirmInstallName(): void {
//   const trimmed = installName.value.trim()
//   emitCompleted('local-new')
//   emit('chain-local', trimmed ? { instName: trimmed } : undefined)
// }
// function backFromNameInstall(): void {
//   step.value = 'localBranch'
// }

interface OpenOpts {
  /** Suppress the cloud-vs-local pick — caller has already detected
   *  that the user has prior launcher usage. Defaults to false. */
  skipPick?: boolean
  /** Surface the migrate-vs-install-new sub-step on the Local branch
   *  because a Legacy Desktop install was detected on this machine.
   *  Defaults to false. */
  hasLegacyDesktop?: boolean
  /** Skip ahead to a specific brand step on open. Used by the
   *  Configure → Back chain to land the user back on the localBranch
   *  sub-step instead of restarting at consent. Defaults to 'consent'. */
  initialStep?: 'consent' | 'pick' | 'localBranch'
}

async function open(opts: OpenOpts = {}): Promise<void> {
  step.value = opts.initialStep ?? 'consent'
  skipPick.value = opts.skipPick === true
  hasLegacyDesktop.value = opts.hasLegacyDesktop === true
  whyCloudOpen.value = false
  termsOpen.value = false
  acceptedTos.value = false
  // TODO(brand-cleanup): installName.value = '' — ref removed; Configure
  // screen now owns naming.
  // Reset funnel-completion bookkeeping so a takeover replay measures
  // duration / steps from the replay, not from the original mount.
  mountedAt = Date.now()
  stepsSeen.clear()
  // Re-seed with the current step so the funnel count includes the
  // initial step on both first mount and replay. The immediate watcher
  // also adds it on first mount, but Set.add is idempotent.
  stepsSeen.add(step.value)
  completedFired = false
  // Pre-load existing telemetry preference so the toggle reflects the
  // user's current persisted choice if the takeover is replaying after
  // a mid-flow cancel (the consent step is the only one that can flip
  // a destructive default).
  const existing = (await window.api.getSetting('telemetryEnabled')) as boolean | undefined
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

/**
 * Push the current step to main as the host's `firstUseMode` so:
 *   - `buildTitlePopupMenuItems` can surface the Skip Onboarding entry
 *     once we're past consent (`'post-consent'`).
 *   - The title bar can lock down during `'consent-lockdown'`.
 *
 * `immediate: true` makes the very first mount fire the watcher so the
 * initial step (`'consent'`) lands on the host without waiting for a
 * step transition. The `localBranch` sub-step counts as `post-consent`
 * — the user has already accepted T&Cs and the menu's escape hatch
 * stays available there.
 */
watch(
  step,
  (current) => {
    const mode = current === 'consent' ? 'consent-lockdown' : 'post-consent'
    window.api.setFirstUseMode(mode)
    stepsSeen.add(current)
    emitTelemetryAction('desktop2.first_use.step_viewed', {
      step: current,
      skip_pick: skipPick.value,
      has_legacy_desktop: hasLegacyDesktop.value
    })
    // TODO(brand-cleanup): nameInstall step retired; Configure screen
    // owns its own input focus.
    // if (current === 'nameInstall') {
    //   void nextTick(() => nameInstallInput.value?.focus())
    // }
  },
  { immediate: true }
)

onUnmounted(() => {
  // Clear the host's `firstUseMode` whenever the takeover unmounts,
  // regardless of why (Cloud-branch
  // completion, Local-branch chain swap, file-menu Skip Onboarding,
  // OS-chrome window close, dev-tools refresh). The host's
  // `dismissTakeoverDirect` ALSO pushes `'none'` for the renderer-
  // internal dismiss path; the duplicate landing here is harmless and
  // keeps unmount paths that go through useOverlay's silent Tier 3 →
  // Tier 3 swap (chain-local) covered too.
  window.api.setFirstUseMode('none')
})

defineExpose({ open })
</script>

<template>
  <BrandTakeoverLayout v-if="isBrandStep" :vignette="step === 'pick'">
    <!-- Step 1: T&C + telemetry consent. Brand-wrapped: wordmark
         centered, two square brand checkboxes (T&C + telemetry), then
         the Get Started / Cancel action row. Full policy text moves
         into TermsModal opened by either Learn more link. -->
    <div v-if="step === 'consent'" class="brand-hero consent-hero">
      <ComfyWordmark class="consent-wordmark" aria-hidden="true" />
      <div class="consent-checkboxes">
        <label class="brand-checkbox" data-testid="first-use-consent-tos">
          <input v-model="acceptedTos" type="checkbox" />
          <span class="brand-checkbox__text">
            <span class="brand-checkbox__title">{{ $t('firstUse.consentTosTitle') }}</span>
            <span class="brand-checkbox__hint">
              {{ $t('firstUse.consentTosHint') }}
              <button
                type="button"
                class="brand-checkbox__link"
                data-testid="first-use-tos-learn-more"
                @click.prevent="termsOpen = true"
              >
                {{ $t('common.learnMore') }}
              </button>
            </span>
          </span>
        </label>
        <label class="brand-checkbox" data-testid="first-use-consent-telemetry">
          <input v-model="telemetryEnabled" type="checkbox" />
          <span class="brand-checkbox__text">
            <span class="brand-checkbox__title">{{ $t('firstUse.consentTelemetryTitle') }}</span>
            <span class="brand-checkbox__hint">
              {{ $t('firstUse.consentTelemetryHint') }}
              <button
                type="button"
                class="brand-checkbox__link"
                data-testid="first-use-telemetry-learn-more"
                @click.prevent="termsOpen = true"
              >
                {{ $t('common.learnMore') }}
              </button>
            </span>
          </span>
        </label>
      </div>
      <div class="consent-actions">
        <button
          class="brand-primary consent-get-started"
          type="button"
          data-testid="first-use-accept-consent"
          :disabled="!acceptedTos"
          @click="acceptConsent"
        >
          {{ $t('firstUse.consentGetStarted') }}
        </button>
        <button
          class="brand-ghost consent-cancel"
          type="button"
          data-testid="first-use-cancel-consent"
          @click="cancelConsent"
        >
          {{ $t('common.cancel') }}
        </button>
      </div>
    </div>

    <!-- Step 3: Cloud-vs-Local pick. -->
    <div v-else-if="step === 'pick'" class="brand-hero">
      <h1 class="brand-title">{{ $t('firstUse.pickTitle') }}</h1>
      <p class="brand-lead">{{ $t('firstUse.pickLead') }}</p>
      <div class="pick-grid" role="radiogroup" :aria-label="$t('firstUse.pickTitle')">
        <ChoiceCard
          class="pick-card-cloud"
          :label="$t('cloud.label')"
          :tagline="$t('firstUse.cloudTagline')"
          :description="$t('firstUse.cloudDesc')"
          glow
          data-testid="first-use-pick-cloud"
          @click="pickCloud"
        />
        <ChoiceCard
          :label="$t('firstUse.localLabel')"
          :tagline="$t('firstUse.localTagline')"
          :description="$t('firstUse.localDesc')"
          data-testid="first-use-pick-local"
          @click="pickLocal"
        />
      </div>
    </div>

    <!-- Step 4 (conditional): Local + Legacy Desktop detected. The
         card recipe is intentionally inlined (not ChoiceCard) — it's
         the only place this dense full-width stacked variant ships,
         so a new component or variant prop on ChoiceCard would be
         over-engineering. -->
    <div v-else-if="step === 'localBranch'" class="brand-hero local-branch-hero">
      <h1 class="brand-title">{{ $t('firstUse.localBranchTitle') }}</h1>
      <p class="brand-lead">{{ $t('firstUse.localBranchLead') }}</p>
      <div
        class="local-branch-list"
        role="radiogroup"
        :aria-label="$t('firstUse.localBranchTitle')"
      >
        <button
          type="button"
          class="lb-card lb-card--recommended"
          data-testid="first-use-local-migrate"
          @click="chooseMigrate"
        >
          <span class="lb-card__icon" aria-hidden="true">
            <FolderInput :size="16" :stroke-width="1.75" />
          </span>
          <span class="lb-card__text">
            <span class="lb-card__label">{{ $t('firstUse.localBranchMigrateLabel') }}</span>
            <span class="lb-card__desc">{{ $t('firstUse.localBranchMigrateDesc') }}</span>
          </span>
          <Check class="lb-card__check" :size="16" :stroke-width="2" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="lb-card"
          data-testid="first-use-local-install-new"
          @click="chooseInstallNew"
        >
          <span class="lb-card__icon" aria-hidden="true">
            <Copy :size="16" :stroke-width="1.75" />
          </span>
          <span class="lb-card__text lb-card__text--install-new">
            <span class="lb-card__label">{{ $t('firstUse.localBranchInstallNewLabel') }}</span>
            <span class="lb-card__desc">{{ $t('firstUse.localBranchInstallNewDesc') }}</span>
          </span>
        </button>
      </div>
    </div>

    <!--
    TODO(brand-cleanup): nameInstall step retired. The Configure screen
    (NewInstallModal brand-config) now hosts the Name input inline. The
    original template/script lives in git history. Restore script refs
    (installName, nameInstallInput, confirmInstallName, backFromNameInstall)
    and the isBrandStep branch if this is ever resurrected.
    -->


    <template #footer-left>
      <button
        v-if="step === 'pick'"
        class="pick-why-cloud"
        type="button"
        data-testid="first-use-why-cloud"
        @click="openWhyCloud"
      >
        <Info :size="14" />
        <span>{{ $t('firstUse.whyTryCloud') }}</span>
      </button>
      <button
        v-else-if="step === 'localBranch'"
        class="pick-why-cloud"
        data-testid="first-use-local-branch-back"
        type="button"
        @click="step = 'pick'"
      >
        ← {{ $t('common.back') }}
      </button>
    </template>

    <WhyTryCloudModal
      v-if="whyCloudOpen"
      @close="dismissWhyCloud('dismiss')"
      @try-cloud="onWhyCloudTryCloud"
    />
    <TermsModal v-if="termsOpen" @close="termsOpen = false" />
  </BrandTakeoverLayout>
  <ModalShell v-else binding hide-close content-class="first-use-takeover">
    <!-- Mirrors step retains the legacy ModalShell chrome until it gets
         the brand treatment. First-use is binding — no ✕ close. -->
    <template #header>
      <TakeoverHeader :title="$t('firstUse.grandTitle')" :subtitle="$t('firstUse.grandSubtitle')" />
    </template>
    <div class="view-scroll">
      <template v-if="step === 'mirrors'">
        <h3 class="first-use-step-title">{{ $t('settings.chineseMirrorsSuggestTitle') }}</h3>
        <p class="first-use-mirrors-lead">{{ $t('settings.chineseMirrorsSuggestMessage') }}</p>
      </template>
    </div>

    <div class="wizard-footer">
      <div class="wizard-back-placeholder"></div>
      <div></div>
      <template v-if="step === 'mirrors'">
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
  </ModalShell>
</template>

<style scoped>
/* Layout for the legacy first-use modal body (mirrors step only). */
.first-use-takeover {
  display: flex;
  flex-direction: column;
}

.first-use-mirrors-lead {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text);
  margin-bottom: 12px;
}

.first-use-step-title {
  font-size: 18px;
  font-weight: 600;
  margin: 0 0 12px 0;
  color: var(--text);
}

/* Consent step: brand-wrapped. Hero column is centred by `.brand-hero`;
 * we just stack wordmark → checkboxes → action row inside it. */
.consent-hero {
  max-width: 560px;
  gap: var(--takeover-gap-md);
}
.consent-wordmark {
  width: clamp(140px, 9.7vw, 240px);
  height: auto;
  color: #f0ff41;
  margin-bottom: var(--takeover-gap-md);
  isolation: isolate;
  anchor-name: --brand-beam-target;
}
.consent-checkboxes {
  display: flex;
  flex-direction: column;
  gap: var(--takeover-gap-sm);
  width: 100%;
  text-align: left;
}
.consent-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: var(--takeover-gap-lg);
}

/* Pick step. Hero/title/lead live as the global `.brand-*` classes
 * (main.css) so the Configure screen can reuse the same primitives.
 * `.pick-why-cloud` is rendered via the layout's #footer-left slot
 * and stays here because its absolute positioning resolves against the
 * outer frame, which the layout preserves as its positioning context. */
.pick-grid {
  display: grid;
  width: 100%;
  grid-template-columns: repeat(auto-fit, minmax(min(360px, 100%), 1fr));
  gap: 30px;
}

.pick-card-cloud {
  anchor-name: --brand-beam-target;
}

.pick-why-cloud {
  position: absolute;
  left: clamp(1.25rem, 2vw, 2rem);
  bottom: clamp(1.25rem, 2vw, 2rem);
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  padding: 6px 4px;
  color: color-mix(in oklab, var(--neutral-100) 70%, transparent);
  font: inherit;
  font-size: var(--takeover-fs-body);
  cursor: pointer;
}
.pick-why-cloud:hover {
  color: var(--neutral-100);
  transition: color 120ms ease;
}
.pick-why-cloud:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: 4px;
}

.local-branch-hero {
  max-width: 820px;
}
.local-branch-list {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 16px;
}
.lb-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 16px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: rgba(138, 134, 136, 0.05);
  backdrop-filter: blur(75px);
  color: var(--neutral-200);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
}
.lb-card:hover {
  background: rgba(138, 134, 136, 0.1);
  border-color: rgba(194, 191, 185, 0.09);
  color: var(--neutral-100);
}
.lb-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.lb-card--recommended {
  background: rgba(138, 134, 136, 0.1);
  border-color: rgba(194, 191, 185, 0.09);
  box-shadow: 0 1px 0 0 rgba(255, 255, 255, 0.1) inset;
  color: var(--neutral-100);
}
.lb-card__icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
}
.lb-card__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.lb-card__label {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-100);
}
.lb-card__desc {
  font-size: var(--takeover-fs-body);
  color: var(--neutral-100);
}
.lb-card__text--install-new {
  opacity: 0.5;
}
.lb-card__text--install-new:hover {
  color: var(--text);
  transition: color 120ms ease;
  opacity: 1;
}

.lb-card__check {
  flex: 0 0 auto;
  color: var(--neutral-100);
}

.first-use-mirror-buttons {
  display: flex;
  gap: 8px;
}

/* TODO(brand-cleanup): name-install scoped styles removed — step retired. */
</style>
