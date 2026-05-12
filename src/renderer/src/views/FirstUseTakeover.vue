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
import { ArrowRightLeft, Box, Cloud, Download } from 'lucide-vue-next'
import TakeoverHeader from '../components/TakeoverHeader.vue'
import ModalShell from '../components/ModalShell.vue'
import MarkdownDoc from '../components/MarkdownDoc.vue'
import { LEGAL_DOCS, DEFAULT_LEGAL_DOC, type LegalDocId } from '../lib/legalDocs'

type Step = 'consent' | 'mirrors' | 'pick' | 'localBranch'

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
   *  `firstUseCompleted` once new-install ends successfully. */
  'chain-local': []
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

const isChinese = computed(() => locale.value.startsWith('zh'))

const activeLegalTab = ref<LegalDocId>('eula')
const activeLegalDoc = computed(
  () => LEGAL_DOCS.find((d) => d.id === activeLegalTab.value) ?? DEFAULT_LEGAL_DOC,
)
const legalPanelEl = ref<HTMLDivElement | null>(null)

/** Switch the active legal tab and reset the reading body to the top.
 *  Without the reset, jumping from the bottom of a long doc into a
 *  short one leaves a stale scroll position that confuses the user. */
function onSelectTab(id: LegalDocId): void {
  activeLegalTab.value = id
  // Defer to next paint so the new doc's body is mounted before scroll.
  requestAnimationFrame(() => {
    if (legalPanelEl.value) legalPanelEl.value.scrollTop = 0
  })
}

/** Step 1 → next: telemetry persists immediately so a mid-flow cancel
 *  still respects the user's choice (the `firstUseCompleted` gate is
 *  separate — re-running the takeover surfaces the toggle in its
 *  current persisted state, not as a freshly-defaulted opt-in). */
async function acceptConsent(): Promise<void> {
  await window.api.setSetting('telemetryEnabled', telemetryEnabled.value)
  // skipPick suppresses the pick step entirely. China-mirror sub-step
  // still runs first when the locale calls for it, then the takeover
  // emits `complete-skip` (returning user — no implicit cloud launch)
  // instead of advancing to `pick`.
  if (isChinese.value) {
    step.value = 'mirrors'
  } else if (skipPick.value) {
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
    window.api.setSetting('chineseMirrorsPrompted', true),
  ])
  if (skipPick.value) {
    emit('complete-skip')
  } else {
    step.value = 'pick'
  }
}

function pickCloud(): void {
  emit('complete-cloud')
}

/** Local branch — when a Legacy Desktop install is on the machine
 *  the user gets a Migrate-vs-Install-new sub-step before the chain
 *  fires; otherwise we go straight to the new-install chain.
 *  Detection (`hasLegacyDesktop`) is computed by main and plumbed in
 *  via `open()`. */
function pickLocal(): void {
  if (hasLegacyDesktop.value) {
    step.value = 'localBranch'
  } else {
    emit('chain-local')
  }
}

function chooseMigrate(): void {
  emit('chain-migrate')
}

function chooseInstallNew(): void {
  emit('chain-local')
}

interface OpenOpts {
  /** Suppress the cloud-vs-local pick — caller has already detected
   *  that the user has prior launcher usage. Defaults to false. */
  skipPick?: boolean
  /** Surface the migrate-vs-install-new sub-step on the Local branch
   *  because a Legacy Desktop install was detected on this machine.
   *  Defaults to false. */
  hasLegacyDesktop?: boolean
}

async function open(opts: OpenOpts = {}): Promise<void> {
  step.value = 'consent'
  skipPick.value = opts.skipPick === true
  hasLegacyDesktop.value = opts.hasLegacyDesktop === true
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
  },
  { immediate: true },
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
  <ModalShell binding hide-close content-class="first-use-takeover">
    <!-- First-use is binding — no ✕ close. The OS-chrome window close
         routes through main → PanelApp's closeOverlay; there's no in-app
         dismiss affordance mid-onboarding. -->
    <template #header>
      <TakeoverHeader
        :title="$t('firstUse.grandTitle')"
        :subtitle="$t('firstUse.grandSubtitle')"
      />
    </template>
      <div class="view-scroll">
        <!-- Step 1: T&C + telemetry consent.
             The full Privacy Policy is embedded inline as a scrollable
             reading box so the user can read what they're agreeing to
             without leaving the app or chasing a link. Source of truth
             for the policy text lives in `lib/privacyPolicy.ts`, which
             mirrors the canonical Notion document. -->
        <template v-if="step === 'consent'">
          <div class="first-use-consent">
            <p class="first-use-lead">{{ $t('firstUse.consentLead') }}</p>
            <!-- Tabs + reading panel form a single bordered card so the
                 tab strip reads as part of the document surface, not a
                 floating chip group. EULA is the default since that's
                 the document the user is affirmatively agreeing to. -->
            <div
              class="first-use-legal-card"
              data-testid="first-use-legal-panel"
              :aria-label="$t(activeLegalDoc.labelKey)"
            >
              <div
                class="first-use-legal-tabs"
                role="tablist"
                :aria-label="$t('firstUse.legalTabsLabel')"
              >
                <button
                  v-for="doc in LEGAL_DOCS"
                  :key="doc.id"
                  role="tab"
                  :aria-selected="activeLegalTab === doc.id"
                  :aria-controls="`first-use-legal-panel-${doc.id}`"
                  :class="['first-use-legal-tab', { active: activeLegalTab === doc.id }]"
                  :data-testid="`first-use-legal-tab-${doc.id}`"
                  @click="onSelectTab(doc.id)"
                >
                  {{ $t(doc.labelKey) }}
                </button>
              </div>
              <div
                :id="`first-use-legal-panel-${activeLegalDoc.id}`"
                ref="legalPanelEl"
                class="first-use-legal-body"
                tabindex="0"
                role="tabpanel"
              >
                <MarkdownDoc :key="activeLegalDoc.id" :markdown="activeLegalDoc.markdown" />
              </div>
            </div>
            <label class="first-use-toggle">
              <input v-model="telemetryEnabled" type="checkbox" />
              <span>{{ $t('settings.telemetryEnabled') }}</span>
            </label>
            <p class="first-use-hint">{{ $t('firstUse.telemetryHint') }}</p>
          </div>
        </template>

        <!-- Step 2: China mirror prompt (only when locale starts with 'zh') -->
        <template v-else-if="step === 'mirrors'">
          <h3 class="first-use-step-title">{{ $t('settings.chineseMirrorsSuggestTitle') }}</h3>
          <p class="first-use-lead">{{ $t('settings.chineseMirrorsSuggestMessage') }}</p>
        </template>

        <!-- Step 3: Cloud vs Local picker.
             Laid out as two big horizontal squares (Local on the
             left, Cloud on the right) so the
             choice reads like a real fork in the road, not a pair of
             checkbox-sized cards. Each tile is a generous click target
             with the source-category icon ChooserView already uses
             for the same install kinds (`Box` for Local, `Cloud` for
             Cloud) so the iconography matches what the user will see
             on the dashboard once they're past first-use. -->
        <template v-else-if="step === 'pick'">
          <h3 class="first-use-step-title">{{ $t('firstUse.pickTitle') }}</h3>
          <p class="first-use-lead">{{ $t('firstUse.pickLead') }}</p>
          <div class="first-use-fork">
            <button
              class="first-use-fork-tile"
              data-testid="first-use-pick-local"
              @click="pickLocal"
            >
              <div class="first-use-fork-icon"><Box :size="64" :stroke-width="1.5" /></div>
              <div class="first-use-fork-title">{{ $t('firstUse.localLabel') }}</div>
              <div class="first-use-fork-desc">{{ $t('firstUse.localDesc') }}</div>
            </button>
            <button
              class="first-use-fork-tile"
              data-testid="first-use-pick-cloud"
              @click="pickCloud"
            >
              <div class="first-use-fork-icon"><Cloud :size="64" :stroke-width="1.5" /></div>
              <div class="first-use-fork-title">{{ $t('cloud.label') }}</div>
              <div class="first-use-fork-desc">{{ $t('cloud.desc') }}</div>
            </button>
          </div>
        </template>

        <!-- Step 4 (conditional): Local + Legacy Desktop detected.
             A Legacy Desktop install was auto-tracked at startup
             (sourceId === 'desktop'), so before chaining into the
             new-install Standalone takeover we ask whether the user
             wants to migrate that install (carries data over via
             `migrate-to-standalone`) or install fresh. The two tiles
             use the same large-square layout as the cloud-vs-local
             pick — same fork-style click target. The Back link in
             the footer returns to the pick step in case the user
             changes their mind. -->
        <template v-else-if="step === 'localBranch'">
          <h3 class="first-use-step-title">{{ $t('firstUse.localBranchTitle') }}</h3>
          <p class="first-use-lead">{{ $t('firstUse.localBranchLead') }}</p>
          <div class="first-use-fork">
            <button
              class="first-use-fork-tile"
              data-testid="first-use-local-migrate"
              @click="chooseMigrate"
            >
              <div class="first-use-fork-icon"><ArrowRightLeft :size="64" :stroke-width="1.5" /></div>
              <div class="first-use-fork-title">{{ $t('firstUse.localBranchMigrateLabel') }}</div>
              <div class="first-use-fork-desc">{{ $t('firstUse.localBranchMigrateDesc') }}</div>
            </button>
            <button
              class="first-use-fork-tile"
              data-testid="first-use-local-install-new"
              @click="chooseInstallNew"
            >
              <div class="first-use-fork-icon"><Download :size="64" :stroke-width="1.5" /></div>
              <div class="first-use-fork-title">{{ $t('firstUse.localBranchInstallNewLabel') }}</div>
              <div class="first-use-fork-desc">{{ $t('firstUse.localBranchInstallNewDesc') }}</div>
            </button>
          </div>
        </template>
      </div>

      <div class="wizard-footer">
        <!-- Back nav for the localBranch sub-step. The user reached
             this step by picking Local at the pick step; if they
             change their mind the Back link returns them to the pick
             step (the only other reachable predecessor — consent
             can't loop). -->
        <div class="wizard-back-placeholder">
          <button
            v-if="step === 'localBranch'"
            class="wizard-back"
            data-testid="first-use-local-branch-back"
            @click="step = 'pick'"
          >
            ← {{ $t('common.back') }}
          </button>
        </div>
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
  </ModalShell>
</template>

<style scoped>
/* Layout for the first-use modal body. */
.first-use-takeover {
  display: flex;
  flex-direction: column;
}

.first-use-lead {
  font-size: 15px;
  line-height: 1.6;
  color: var(--text);
  margin-bottom: 12px;
}

/* Consent-step layout: flex column that fills the parent `view-scroll`
 * so the privacy-policy reading box can grow to fill the available
 * height instead of leaving a wonky empty band below the toggle.
 * Lead/toggle/hint are fixed-height; only the policy box scrolls. */
.first-use-consent {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* Tabs + reading panel as one bordered card. The tab strip is the
 * card's header row; the panel is its scrollable body. Active tab
 * uses an accent-coloured underline (matching the `filter-tabs` pattern
 * elsewhere in the app) so the tabs read as navigation, not floating
 * chips disconnected from the panel. */
.first-use-legal-card {
  flex: 1 1 auto;
  min-height: 240px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 16px;
}

.first-use-legal-tabs {
  display: flex;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.first-use-legal-tab {
  position: relative;
  padding: 10px 20px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 120ms ease;
}

.first-use-legal-tab:hover {
  color: var(--text);
}

.first-use-legal-tab.active {
  color: var(--text);
  font-weight: 600;
}

/* Pixel-aligned indicator pill underneath the active tab. Pinning it
 * with absolute positioning instead of a border-bottom avoids the
 * fuzzy edge that happens when a 2px border overlaps the strip's
 * 1px divider at a half-pixel boundary. The pill is inset from the
 * tab edges so it reads as a marker, not a full underline. */
.first-use-legal-tab.active::after {
  content: '';
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: -1px;
  height: 2px;
  background: var(--accent);
  border-radius: 1px;
}

.first-use-legal-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -3px;
  border-radius: 4px;
}

/* Scrolling body. The tab strip stays pinned at the top of the card
 * while the body scrolls underneath, so the user never loses the tab
 * navigation when reading a long document. */
.first-use-legal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
  user-select: text;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
}

.first-use-legal-body:focus {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent);
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

/* Two-tile fork layout for the cloud-vs-local pick. The tiles want
 * to read as a real choice, not a pair of checkbox-sized cards — each
 * one is a generous click target with the icon centered above the
 * title and a short description underneath. The tiles stay side-by-side
 * on the panel's normal width and shrink to a single column only on
 * very narrow viewports (the host window has a min width that keeps
 * the side-by-side layout for any realistic user). */
.first-use-fork {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
  margin-top: 24px;
}

@media (max-width: 600px) {
  .first-use-fork {
    grid-template-columns: 1fr;
  }
}

.first-use-fork-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  /* Square-ish click target — `aspect-ratio` keeps the tiles balanced
   * when the available width changes, with a min-height floor so the
   * tile never collapses below a comfortable click target. */
  aspect-ratio: 1 / 1;
  min-height: 240px;
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  text-align: center;
  cursor: pointer;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}

.first-use-fork-tile:hover {
  border-color: var(--accent);
  background: var(--surface-hover, var(--surface));
  transform: translateY(-1px);
}

.first-use-fork-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.first-use-fork-icon {
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
}

.first-use-fork-tile:hover .first-use-fork-icon {
  color: var(--accent);
}

.first-use-fork-title {
  font-size: 20px;
  font-weight: 600;
}

.first-use-fork-desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  max-width: 32ch;
}

.first-use-mirror-buttons {
  display: flex;
  gap: 8px;
}
</style>
