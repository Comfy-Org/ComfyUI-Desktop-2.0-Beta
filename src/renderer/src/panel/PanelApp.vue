<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsModal from '../views/SettingsModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import ChooserView from '../views/ChooserView.vue'
import NewInstallModal from '../views/NewInstallModal.vue'
import TrackModal from '../views/TrackModal.vue'
import LoadSnapshotModal from '../views/LoadSnapshotModal.vue'
import QuickInstallModal from '../views/QuickInstallModal.vue'
import FirstUseTakeover from '../views/FirstUseTakeover.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useListAction } from '../composables/useListAction'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useOverlay, type FlowComponent } from '../composables/useOverlay'
import { useModal } from '../composables/useModal'
import { useAppUpdatePrompts } from '../composables/useAppUpdatePrompts'
import { useSendFeedback } from '../composables/useSendFeedback'
import { useDeepLinkRouter } from '../composables/useDeepLinkRouter'
import { emitTelemetryAction } from '../lib/telemetry'
import type { ActionResult, Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Body modes the panel WebContentsView can render. Mirrors the `BodyMode`
 * union in `src/main/index.ts` — `'comfy-lifecycle'` is the lifecycle UI
 * shown for the Comfy tab when no ComfyUI process is running, `'chooser'`
 * is the install-picker shown for the Comfy tab of an install-less host
 * window, `'settings'` mounts the unified Settings modal as an overlay
 * over the underlying body, and the remaining keys mount the install-
 * flow wizards as Tier 3 takeovers.
 */
export type PanelKey =
  | 'comfy-lifecycle'
  | 'chooser'
  | 'settings'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

const VALID_PANELS: ReadonlySet<PanelKey> = new Set([
  'comfy-lifecycle',
  'chooser',
  'settings',
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/**
 * Panels that wrap a `*Modal` component which exposes an imperative
 * `open()` reset. These mount in the host's takeover overlay slot
 * (Tier 3) via `useOverlay` rather than as a body branch. The set
 * is still keyed on PanelKey because main still addresses these as
 * "panel switch" requests (URL `?panel=…` and the `panel-switch`
 * IPC) — `switchPanel` diverts them into
 * `openOverlay({ kind: 'takeover', component })` instead of
 * assigning `activePanel`.
 *
 * Each entry has a matching `*Ref` template ref so we can call the
 * imperative `open()` reset after the takeover mounts (form state
 * carries over otherwise).
 */
const FLOW_PANELS: ReadonlySet<PanelKey> = new Set([
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/**
 * Telemetry — `flow:` strings sent with
 * `desktop2.install.flow.opened`. Keep these values stable so the
 * existing PostHog / Datadog dashboards keyed off `flow` keep
 * working.
 */
const FLOW_TELEMETRY_NAMES: Record<FlowComponent, string> = {
  'new-install': 'new_install',
  'quick-install': 'quick_install',
  track: 'track_existing',
  'load-snapshot': 'load_snapshot',
}

const { mergeLocaleMessage, locale, t } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
/**
 * The default body panel for this host — the surface that sits
 * underneath any takeover overlay. Install-backed hosts default to
 * launcher-settings, install-less hosts default to the chooser.
 * Used both for the initial mount (when the URL doesn't request a
 * specific panel) AND as the underlying body when the initial URL
 * panel is a flow-takeover (`?panel=new-install` etc.).
 */
function defaultBodyPanel(): PanelKey {
  return installationId ? 'comfy-lifecycle' : 'chooser'
}
const initialPanel: PanelKey = ((): PanelKey => {
  const raw = params.get('panel')
  if (raw && VALID_PANELS.has(raw as PanelKey)) return raw as PanelKey
  return defaultBodyPanel()
})()

// `activePanel` is the underlying body. Flow keys and the unified
// settings key never sit here — they mount in the overlay slot via
// the post-mount `switchPanel(initialPanel)` in `onMounted`.
const activePanel = ref<PanelKey>(
  FLOW_PANELS.has(initialPanel) || initialPanel === 'settings'
    ? defaultBodyPanel()
    : initialPanel,
)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)
const firstUseRef = ref<InstanceType<typeof FirstUseTakeover> | null>(null)

/**
 * Set when the first-use takeover's Local branch chains into the
 * new-install Tier 3 takeover. The new-install
 * modal emits `close` after a successful install (the same hook used
 * everywhere); when that fires while this flag is true the host
 * marks `firstUseCompleted` and clears the flag. A Cloud branch pick
 * marks completion immediately and never sets this flag, so the two
 * paths can't double-fire the pref write.
 */
const chainingFirstUseToNewInstall = ref(false)

/**
 * Installation id of the Standalone install that the first-use chain
 * (new-install or
 * migration) just kicked off. Captured from the corresponding
 * `show-progress` while a chain flag is set. The progressStore
 * watcher below auto-launches the install once its op finishes
 * successfully, so the user lands on a running ComfyUI as the
 * natural endpoint of first-use without having to click play again.
 * Cleared after launch (or on chain cancel) so the next first-use
 * replay starts clean.
 */
const pendingFirstUseAutoLaunchId = ref<string | null>(null)

const sessionStore = useSessionStore()
const installationStore = useInstallationStore()
const progressStore = useProgressStore()
const launcherPrefs = useLauncherPrefs()

/**
 * Host-level overlay slot. Owns the in-flight progress (`progress`
 * kind) and Tier 3 takeovers (`takeover` kind — the four flow
 * modals plus the first-use flow). Manage / Tier 1 overlays driven
 * by ChooserView mount in ChooserView's own slot — see `useOverlay`
 * for the tier-collision rules. The `current` ref is destructured
 * to a top-level binding so the template can read it via Vue's
 * auto-unwrap.
 */
const { current: currentOverlay, openOverlay, closeOverlay } = useOverlay()

const modal = useModal()
const { showAppUpdateRestartPrompt, showAppUpdateDownloadPrompt } = useAppUpdatePrompts()

// installationStore.fetchInstallations() is wired to onInstallationsChanged
// inside the store itself, so the panel just needs to read from it.
const installation = computed<Installation | null>(
  () => (installationId ? installationStore.getById(installationId) ?? null : null),
)

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubCloseRequest: (() => void) | null = null
let unsubFirstUseSkip: (() => void) | null = null
let unsubAppUpdatePromptRestart: (() => void) | null = null
let unsubAppUpdateUserActionFailed: (() => void) | null = null
useSendFeedback()

/**
 * Resolves once `onMounted` has finished its async bootstrap (locale +
 * sessionStore + installationStore + launcherPrefs). The install-update
 * deep-link handler awaits this before resolving the installation so a
 * `panel-trigger-overlay` IPC that arrives during the panelView's
 * first `did-finish-load` (i.e. before the store has hydrated) doesn't
 * silently drop the click — it queues until the unified Settings modal
 * can render against a populated store and translated copy.
 */
let resolveBootstrap: (() => void) | null = null
const bootstrapReady: Promise<void> = new Promise<void>((resolve) => {
  resolveBootstrap = resolve
})

useDeepLinkRouter({
  installationId,
  bootstrapReady,
  openOverlay,
  showAppUpdateRestartPrompt,
  showAppUpdateDownloadPrompt,
})

async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  // Merge — not replace — so the renderer-side catalog from
  // `lib/i18nMessages.ts` (the authoritative en source for keys main
  // doesn't yet ship in `locales/en.json`, e.g. `downloadsTab.*`,
  // `downloadsPopup.*`, `fileMenu.*`) survives this layer-on of
  // main's JSON.
  mergeLocaleMessage('en', messages)
  locale.value = 'en'
}

/**
 * `show-progress` from any panel body (DetailModal, ChooserView,
 * NewInstallModal, …). Routes through the host's overlay slot so the
 * Tier 2 collision rules apply — replacing one in-flight progress op
 * with another prompts the user to cancel via the standardised copy.
 *
 * If the install is currently running, the operation must end in
 * the running app (Update Now restarts after
 * applying), so route as a Tier 3 takeover instead of Tier 2 progress.
 * Both branches mount the same `ProgressModal` (one ref, since the
 * `v-if`/`v-else-if` slots are mutually exclusive) — only the wrapper
 * tier and full-window styling differ.
 *
 * Re-show of an already-running op is a no-op `openOverlay` to the
 * same slot followed by `showOperation` on the modal ref; the slot
 * already has the right kind+id, so the `current` swap is idempotent.
 */
async function handleShowProgress(opts: ShowProgressOpts): Promise<void> {
  // Manage→Progress restoration relies on the title carrying the
  // operation name (e.g. `"Updating ComfyUI — Local install"`); strip
  // the install suffix for the cancel-prompt copy so the prompt reads
  // `Cancel "Updating ComfyUI"?` instead of leaking the install name.
  const operationName = opts.title.split(' — ')[0] || opts.title
  // Capture the operation's installation id when a first-use chain
  // is in flight (new-install or migrate). The progressStore
  // watcher above auto-launches the resulting install once the op
  // finishes successfully. New-install ops carry the new install's
  // id directly; migrate ops carry the Legacy Desktop install's id
  // and the watcher resolves the resulting Standalone install from
  // the store after the op finishes. Only the first chained op
  // captures the id — subsequent show-progress calls (e.g. user
  // re-opens an in-progress modal) leave it untouched.
  if (chainingFirstUseToNewInstall.value && pendingFirstUseAutoLaunchId.value === null) {
    pendingFirstUseAutoLaunchId.value = opts.installationId
    // First-use chain has just kicked off the long-running install op.
    // Flip the persisted gate now so the takeover doesn't re-run on
    // the next launch — the overlay handoff doesn't go through
    // NewInstallModal's close emit.
    void launcherPrefs.markFirstUseCompleted()
  }
  const isRunning = sessionStore.isRunning(opts.installationId)
  // Keep the opaque takeover chrome alive when first-use is chaining
  // into the install + auto-launch sequence. Without this the swap
  // from the new-install Tier 3 takeover to a Tier 2 progress overlay
  // exposes the dashboard underneath, breaking the bootstrap UX.
  const useTakeover = isRunning || chainingFirstUseToNewInstall.value
  // Wire `onCancel` so a window-close consult that the user
  // confirms (or any other slot-clearing
  // transition that fires the cancel-prompt) actually cancels the
  // in-flight op in main rather than orphaning it via window
  // destruction. Mirrors the manual cancel button inside ProgressModal
  // (`handleCancel` → `progressStore.cancelOperation`); both branches
  // wrap the same store op.
  const onCancel = (): void => {
    progressStore.cancelOperation(opts.installationId)
  }
  const ok = await openOverlay(
    useTakeover
      ? {
          kind: 'takeover',
          component: 'update',
          installationId: opts.installationId,
          operationName,
          onCancel,
        }
      : {
          kind: 'progress',
          installationId: opts.installationId,
          operationName,
          onCancel,
        },
  )
  if (!ok) return
  // Install-less host + launch-class op: subscribe to the resulting
  // `instance-started` broadcast so the chooser host closes itself
  // when the new comfy window opens. Mirrors what the chooser-tile
  // path does via `performChooserLaunch`; needed here because surfaces
  // like DetailModal route launches straight through `show-progress`
  // without going through `prepareChooserHostHandoff`. Idempotent
  // double-call is safe — `prepareChooserHostHandoff` clears any
  // prior `pendingPickUnsub` before re-subscribing.
  if (opts.triggersInstanceStart && !installationId) {
    await prepareChooserHostHandoff(opts.installationId)
  }
  await nextTick()
  // If an in-progress operation already exists for this ID, just show it
  const existing = progressStore.operations.get(opts.installationId)
  if (existing && !existing.finished) {
    progressRef.value?.showOperation(opts.installationId)
    return
  }
  progressRef.value?.startOperation({
    installationId: opts.installationId,
    title: opts.title,
    apiCall: opts.apiCall as () => Promise<ActionResult>,
    cancellable: opts.cancellable,
    returnTo: opts.returnTo,
  })
}

function handleProgressClose(): void {
  // Direct close (✕ on a finished op, or auto-close via the
  // window-mode launch watcher) — bypass `openOverlay`'s cancel
  // prompt because the op has already finished. Cancellation of an
  // in-flight op flows through `progressStore.cancelOperation`.
  currentOverlay.value = null
}

/**
 * Open one of the four flow modals as a Tier 3 takeover overlay
 * (full-window body sitting above the underlying panel). The
 * imperative `open()` reset on each *Modal ref runs after the
 * takeover mounts so form state always starts fresh.
 *
 * Returns silently if `openOverlay` was rejected (the user dismissed
 * the cancel-prompt that fires when an in-flight Tier 2 progress op
 * is being pre-empted — see `useOverlay`'s tier-collision rules).
 */
async function openFlowTakeover(component: FlowComponent, entrypoint: string): Promise<void> {
  // Opt the install-flow wizards into the dedicated "Discard install
  // setup?" cancel-prompt copy so a
  // window-close consult during the wizard reads correctly. The
  // wizards have no destructive op in flight (the install hasn't been
  // kicked off yet — that happens after the wizard's final step,
  // routed through `handleShowProgress` and the Tier 2 ProgressModal),
  // so the generic "Cancel current operation?" copy is misleading.
  // No `onCancel` is set — there is no main-side rollback to fire,
  // just a wizard to dismiss.
  const ok = await openOverlay({ kind: 'takeover', component, cancelCopyKey: 'discard-setup' })
  if (!ok) return
  // Telemetry (issue #485) — single chokepoint that fires
  // `desktop2.install.flow.opened` for all four wizards. The
  // `entrypoint` is supplied by the caller so the dashboard can
  // tell title-bar opens from chooser-empty-state opens etc.
  emitTelemetryAction('desktop2.install.flow.opened', {
    flow: FLOW_TELEMETRY_NAMES[component],
    entrypoint,
  })
  // Wait for the v-if branch in the takeover slot to mount the
  // component before reaching for its ref.
  await nextTick()
  if (component === 'new-install') await newInstallRef.value?.open()
  else if (component === 'track') trackRef.value?.open()
  else if (component === 'load-snapshot') loadSnapshotRef.value?.open()
  else if (component === 'quick-install') await quickInstallRef.value?.open()
}

/**
 * Open the first-use takeover. Same shape as
 * `openFlowTakeover` but the component identifier is the free-form
 * `'first-use'` string (TakeoverOverlay.component is intentionally
 * untyped — see useOverlay.ts) and the post-mount reset goes through
 * the FirstUseTakeover ref's own `open()`. Auto-mounted from
 * `onMounted` when `launcherPrefs.firstUseCompleted` is false; not
 * routed through `switchPanel` because there's no URL/IPC entry point
 * for it (the gate is purely the persisted pref).
 *
 * Fetches the categorised first-use state from main
 * (`getFirstUseState`) so the takeover can suppress the
 * cloud-vs-local pick step for returning users (any non-cloud,
 * non-legacy-desktop install present means the user has already
 * used the launcher; don't re-litigate the choice). The fetch runs
 * in parallel
 * with the overlay mount — by the time `nextTick` resolves and we
 * reach for the imperative `open()` the IPC has usually already
 * settled, so the await is effectively free.
 */
async function openFirstUseTakeover(): Promise<void> {
  const statePromise = window.api.getFirstUseState()
    .catch(() => ({ skipPick: false, hasLegacyDesktop: false }))
  // Opt the takeover into the dedicated "Quit setup?" cancel-prompt
  // copy so the OS-X consult
  // (main → `onCloseRequest` → `closeOverlay`) reads as a binding-
  // flow exit dialog rather than the generic
  // `overlay.cancelCurrentTitle` ("Cancel current operation?").
  const ok = await openOverlay({
    kind: 'takeover',
    component: 'first-use',
    cancelCopyKey: 'quit-setup',
  })
  if (!ok) return
  await nextTick()
  const state = await statePromise
  await firstUseRef.value?.open({
    skipPick: state.skipPick,
    hasLegacyDesktop: state.hasLegacyDesktop,
  })
}

/**
 * Bypass the takeover→null cancel-prompt for
 * renderer-internal intentional close paths (✕ on a takeover,
 * post-completion auto-close). The prompt belongs to the
 * consult-from-main `onCloseRequest` path; firing it on a user's
 * own ✕ click would be a redundant double-confirm. Mirrors the
 * `handleProgressClose` direct-mutation pattern.
 */
function dismissTakeoverDirect(): void {
  // Whenever a Tier 3 overlay is cleared from the renderer side,
  // the host's first-use mode must
  // drop back to `'none'`. This covers both the explicit completion
  // paths (Cloud / chain-local close handlers) AND the pure-dismiss
  // paths (Track / LoadSnapshot / QuickInstall / Manage / Progress
  // ✕). FirstUseTakeover.vue's own watch(step, …, immediate) handles
  // the consent → post-consent transitions; the renderer-internal
  // dismiss is the only place that can take the host from a non-'none'
  // mode to 'none' without a step change inside the takeover.
  if (currentOverlay.value?.kind === 'takeover' && currentOverlay.value.component === 'first-use') {
    window.api.setFirstUseMode('none')
  }
  // Any overlay opened via `setActivePanel` in main (the unified
  // settings overlay, and the four flow takeovers fired from the file
  // menu) flipped `entry.activePanel` away from `'comfy'`. Closing
  // the overlay only clears the renderer-side slot — without IPC'ing
  // main back to `'comfy'` two things break:
  //   - For settings: the live comfy WebContentsView stays hidden and
  //     the user perceives the running instance as "shut down".
  //   - For flow takeovers (new-install / track / load-snapshot /
  //     quick-install): `entry.activePanel` is stuck on the wizard
  //     key, so re-picking the same item from the file menu hits
  //     `setActivePanel`'s same-panel early-return and the modal
  //     never reopens.
  // `closeCurrentPanel` resets `entry.activePanel` to `'comfy'` and
  // re-runs layoutViews(), keeping main and the renderer in sync.
  const cur = currentOverlay.value
  const isFlowTakeover =
    cur?.kind === 'takeover' &&
    (FLOW_PANELS as ReadonlySet<string>).has(cur.component)
  if (cur?.kind === 'settings' || isFlowTakeover) {
    window.api.closeCurrentPanel()
  }
  currentOverlay.value = null
}

/** Shared completion helper. The Cloud-branch pick
 *  (`handleFirstUseComplete`) and the file-menu
 *  Skip Onboarding entry (`onFirstUseSkip` listener) and the
 *  new-install chain close (`handleNewInstallTakeoverClose`) all run
 *  the same `markFirstUseCompleted` → dismiss sequence; extracting
 *  the pair keeps them in sync if the gate flip ever needs extra
 *  state cleanup (e.g. a future telemetry event). */
async function completeFirstUseAndDismiss(): Promise<void> {
  // Clear chain state so the auto-launch watcher doesn't fire after
  // a Skip Onboarding triggered mid-chain (the user wants OUT of
  // onboarding, not to land on a freshly-installed Comfy).
  chainingFirstUseToNewInstall.value = false
  pendingFirstUseAutoLaunchId.value = null
  await launcherPrefs.markFirstUseCompleted()
  // dismissTakeoverDirect pushes `'none'` only when the overlay is
  // the first-use takeover itself; chain dismiss paths can have a
  // new-install / progress takeover in the slot, so push it
  // explicitly to keep the file-menu builder in steady state.
  window.api.setFirstUseMode('none')
  dismissTakeoverDirect()
}

/** First-use takeover Cloud-branch pick (`complete-cloud` emit) — the
 *  user explicitly picked Cloud at the cloud-vs-local fork. We mark
 *  completion, close the takeover, and auto-launch the always-present
 *  Cloud install so they reach a running ComfyUI as the natural
 *  endpoint of first-use without having to click play again. The
 *  launch goes through the same `useListAction` pipeline the chooser
 *  uses (close-host-window-on-instance-started, etc.). If the cloud
 *  install can't be found for any reason we still mark complete and
 *  close the takeover — the chooser body underneath is the fallback.
 *
 *  The returning-user `complete-skip` emit is wired directly to
 *  `completeFirstUseAndDismiss` instead — those users never picked
 *  Cloud (the fork was suppressed), so auto-launching it would
 *  hijack their existing local install. */
async function handleFirstUseComplete(): Promise<void> {
  chainingFirstUseToNewInstall.value = false
  // Mark completion but DON'T dismiss the takeover yet — dismissing
  // first would expose the dashboard underneath while the launch
  // action races to mount its own progress overlay. Cloud's launch
  // action has `showProgress: true`, so the launch goes through
  // `handleShowProgress` → `openOverlay({ kind: 'takeover',
  // component: 'update' })` which silently swaps the first-use
  // takeover for the connect-progress takeover (Tier 3 → Tier 3).
  await launcherPrefs.markFirstUseCompleted()
  window.api.setFirstUseMode('none')
  // Find the auto-seeded Cloud install. The store may not be hydrated
  // yet on first-launch, so we fall back to a fresh fetch via main.
  let cloud = installationStore.installations.find((i) => i.sourceCategory === 'cloud') ?? null
  if (!cloud) {
    try {
      const all = await window.api.getInstallations()
      cloud = all.find((i) => i.sourceCategory === 'cloud') ?? null
    } catch {}
  }
  if (cloud) {
    // If the cloud install has no resolvable launch action (defensive
    // fallback — production cloud sources always provide one), dismiss
    // the takeover so the user lands on the chooser body underneath.
    // The successful happy path leaves the takeover up; the launch
    // action's `showProgress: true` swaps it for a connect-progress
    // takeover via `handleShowProgress` (Tier 3 → Tier 3 silent).
    await performChooserLaunch(cloud, dismissTakeoverDirect)
    return
  }
  // No cloud install to launch into — fall back to dismissing the
  // takeover so the user lands on the chooser body underneath.
  dismissTakeoverDirect()
}

/** First-use takeover Local-branch pick — chain into the new-install
 *  Tier 3 takeover. The Tier 3 → Tier 3 swap is silent in
 *  `useOverlay`, so the first-use takeover unmounts as the
 *  new-install takeover mounts. The completion flip is deferred to
 *  the new-install close path (see `handleNewInstallTakeoverClose`). */
async function handleFirstUseChainLocal(): Promise<void> {
  chainingFirstUseToNewInstall.value = true
  pendingFirstUseAutoLaunchId.value = null
  await switchPanel('new-install', 'first_use')
  // FirstUseTakeover.onUnmounted just pushed `'none'` as the chain
  // swap unmounted it. Re-assert `'post-consent'` so the file-menu
  // builder keeps the chain locked down to Skip Onboarding while
  // the new-install / install-progress takeover is up.
  window.api.setFirstUseMode('post-consent')
}

/** First-use takeover migrate-branch pick — runs the
 *  migrate-to-standalone action against the auto-tracked Legacy
 *  Desktop install. Same shape as the chain-local path: the
 *  migration progress op flows through `handleShowProgress` (Tier 2
 *  progress modal), capturing `pendingFirstUseAutoLaunchId` for the
 *  resulting Standalone install along the way. The progressStore
 *  watcher below auto-launches once the op finishes successfully. */
const { confirmMigration } = useMigrateAction()
async function handleFirstUseChainMigrate(): Promise<void> {
  // Find the auto-tracked Legacy Desktop install.
  let legacy = installationStore.installations.find((i) => i.sourceId === 'desktop') ?? null
  if (!legacy) {
    try {
      const all = await window.api.getInstallations()
      legacy = all.find((i) => i.sourceId === 'desktop') ?? null
    } catch {}
  }
  if (!legacy) {
    // Detection drift — main flagged hasLegacyDesktop=true but the
    // install is gone now. Bail to chain-local so the user still gets
    // to the new-install Standalone path.
    handleFirstUseChainLocal()
    return
  }
  // confirmMigration shows its own modal (variant pick / preview /
  // confirm); a `null` return means user cancelled, in which case we
  // leave the takeover mounted on the localBranch step (no state
  // change).
  const result = await confirmMigration(legacy)
  if (!result) return

  // Pre-mark the chain so the new install kicked off by migration
  // gets captured as the auto-launch target. The migration emits
  // installations-changed when the new Standalone install is added,
  // and `handleShowProgress` carries the `installationId` through —
  // we record it there.
  chainingFirstUseToNewInstall.value = true
  pendingFirstUseAutoLaunchId.value = null
  // Dismiss the takeover before kicking off the migration so the
  // Tier 2 progress modal isn't blocked by the takeover overlay.
  dismissTakeoverDirect()
  await handleShowProgress({
    installationId: legacy.id,
    title: `Migrating — ${legacy.name}`,
    apiCall: () => window.api.runAction(legacy!.id, 'migrate-to-standalone', result),
    cancellable: true,
  })
  // dismissTakeoverDirect pushed `'none'` as it cleared the first-use
  // overlay; re-assert `'post-consent'` so the file-menu builder
  // keeps the chain locked down to Skip Onboarding for the duration
  // of the migration progress + auto-launch.
  window.api.setFirstUseMode('post-consent')
}

/** Wrapper around `closeOverlay` for the new-install takeover branch
 *  that also flips `firstUseCompleted` when the close arrives at the
 *  end of a first-use → Local chain. The new-install modal emits
 *  `close` after a successful install AND on user-cancel (✕); both
 *  cases count as "the user got past the cloud-or-local pick", so we
 *  treat any close arriving via this chain as completion. */
async function handleNewInstallTakeoverClose(): Promise<void> {
  if (chainingFirstUseToNewInstall.value) {
    await launcherPrefs.markFirstUseCompleted()
    // The chain pushed `'post-consent'` to keep Skip Onboarding the
    // only file-menu entry while the new-install takeover was up.
    // Clear it here — whatever follows (dismiss back to chooser, or
    // an in-flight progress / launch overlay swap) is post-onboarding.
    window.api.setFirstUseMode('none')
    // Don't clear `chainingFirstUseToNewInstall` yet — the auto-launch
    // watcher uses it together with `pendingFirstUseAutoLaunchId` to
    // decide whether to fire. The watcher clears both after launch.
  }
  // Only dismiss when the new-install takeover is still in the slot.
  // The happy-path install handoff in NewInstallModal swaps the
  // overlay to a progress takeover via @show-progress without first
  // emitting `close`, but `@navigate-list` still routes here for the
  // skipInstall branch — and dismissing then would clear an unrelated
  // overlay if anything else has claimed the slot in between.
  if (
    currentOverlay.value?.kind === 'takeover'
    && currentOverlay.value.component === 'new-install'
  ) {
    dismissTakeoverDirect()
  }
}

/** Shared launch path for chooser-tile clicks AND the first-use
 *  takeover's auto-launch. Both surfaces want the same five-step
 *  shape (already-running short-circuit → resolve launch action →
 *  in-place attach claim → executeAction). Extracted to one helper
 *  so a future change to the launch UX can't regress one surface
 *  but not the other.
 *
 *  `onMissingLaunchAction` is the only thing that diverges:
 *    - chooser tile click → fall back to the new-install flow inside
 *      this host (the user picked a tile that has no launch path
 *      because the install isn't yet installed).
 *    - first-use auto-launch → silently no-op (the chained new-install
 *      op already finished, anything missing is genuinely "no
 *      launchable install" and we don't want to bounce the user back
 *      into a wizard immediately after they finished one). */
async function performChooserLaunch(
  installation: Installation,
  onMissingLaunchAction: () => void = () => {},
): Promise<void> {
  if (sessionStore.isRunning(installation.id)) {
    // Focus the running window and leave the chooser host alive
    // (tile clicks transform the host the user clicked from instead
    // of closing it). The chooser host has no install backing it,
    // so there's no detach to do; the surplus window is the price
    // of keeping the user's panel context intact.
    await window.api.focusComfyWindow(installation.id)
    return
  }
  const actions = await window.api.getListActions(installation.id)
  const launchAction = actions.find((a) => a.id === 'launch')
    ?? actions.find((a) => a.style === 'primary')
    ?? null
  if (!launchAction) {
    onMissingLaunchAction()
    return
  }
  await prepareChooserHostHandoff(installation.id)
  await executeChooserAction(installation, launchAction)
}

/** Watch progressStore for the new-install / migration op finishing
 *  and auto-launch the resulting Standalone
 *  install. The chain flag (`chainingFirstUseToNewInstall`) gates
 *  the watcher so we only auto-launch when the op was actually
 *  driven by the first-use chain. The captured id
 *  (`pendingFirstUseAutoLaunchId`) is set in `handleShowProgress` at
 *  the moment the chained op begins. */
watch(
  () => {
    const id = pendingFirstUseAutoLaunchId.value
    if (!id) return null
    const op = progressStore.operations.get(id)
    return op && op.finished ? op : null
  },
  async (op) => {
    if (!op) return
    if (!chainingFirstUseToNewInstall.value) return
    const id = pendingFirstUseAutoLaunchId.value
    chainingFirstUseToNewInstall.value = false
    pendingFirstUseAutoLaunchId.value = null
    // Chain is done (success or failure) — drop the file-menu lock.
    // The launch path that follows (when the op succeeded) replaces
    // the install-progress takeover with its own connect-progress
    // takeover; either way the user is past onboarding now.
    window.api.setFirstUseMode('none')
    if (!id) return
    if (op.cancelRequested || op.error || !op.result?.ok) return
    // The migrate-to-standalone op runs against the Legacy Desktop
    // install but produces a fresh Standalone install — wait for
    // the store to reflect the new install, then launch the
    // most-recently-created non-cloud, non-legacy local install
    // (the migration's result). For new-install ops, the captured
    // id is the new install's id directly so this branch resolves
    // immediately.
    let inst = installationStore.installations.find((i) => i.id === id) ?? null
    if (!inst || inst.sourceId === 'desktop') {
      // Migration case — the captured id was the Legacy Desktop
      // install. Find
      // the freshly-added Standalone install (it's the newest install
      // with `copiedFrom === id`, falling back to the newest local).
      try {
        await installationStore.fetchInstallations()
      } catch {}
      inst = installationStore.installations.find(
        (i) => (i as unknown as { copiedFrom?: string }).copiedFrom === id,
      ) ?? installationStore.installations
        .filter((i) => i.sourceCategory === 'local')
        .sort((a, b) => Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? '')))[0]
        ?? null
    }
    if (inst) {
      void performChooserLaunch(inst)
    }
  },
  { deep: false },
)

/**
 * Switch the underlying panel body. Flow keys (`new-install` / `track`
 * / `load-snapshot` / `quick-install`) divert into the Tier 3
 * takeover overlay slot instead of swapping the body — see
 * `openFlowTakeover` for why. The unified `settings` key opens the
 * Tier 1 SettingsModal at the default tab for the host (ComfyUI
 * Settings on install-backed, Global Settings on install-less);
 * deeper tab targets (e.g. install-update) come through the
 * `panel-trigger-overlay` IPC and bypass `switchPanel`.
 *
 * For non-overlay keys: the assignment is idempotent — re-selecting
 * the already-active panel is a no-op.
 */
async function switchPanel(panel: PanelKey, entrypoint: string = 'titlebar'): Promise<void> {
  // Capture the underlying body BEFORE any mutation so the
  // `desktop2.view.opened` event reports the right `from_view`.
  const fromView = activePanel.value
  if (FLOW_PANELS.has(panel)) {
    await openFlowTakeover(panel as FlowComponent, entrypoint)
    return
  }
  // Unified Settings modal. Mounts as a Tier 1 overlay on top of
  // the underlying chooser / comfy-lifecycle body. The default tab
  // is ComfyUI Settings on install-backed hosts, Global Settings on
  // install-less hosts; deeper tab targets come through
  // `panel-trigger-overlay`.
  if (panel === 'settings') {
    const inst = installation.value
    const initialTab = inst ? 'comfy' : 'global'
    const ok = await openOverlay({
      kind: 'settings',
      installation: inst,
      initialTab,
    })
    if (!ok) return
    emitTelemetryAction('desktop2.view.opened', { view: panel, from_view: fromView })
    emitTelemetryAction('desktop2.settings.opened', {
      initial_tab: initialTab,
      entrypoint,
      has_installation: !!inst,
    })
    return
  }
  // Body-swap branch — `if (view !== fromView)` no-op guard so a
  // redundant `panel-switch` IPC (e.g. main re-confirms
  // `'comfy-lifecycle'` after an instance stop while we're already
  // there) doesn't generate a noise event.
  if (panel === fromView) return
  activePanel.value = panel
  emitTelemetryAction('desktop2.view.opened', { view: panel, from_view: fromView })
}

function handleUpdateInstallation(inst: Installation): void {
  // Optimistic local update for snappier UX while the broadcast-driven
  // refetch is in flight (e.g. rename via the editable title).
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
}

// --- Chooser handlers (install-less host window only) ---
//
// Chooser pick triggers the install's launch action
// directly from the panel renderer, mirroring the Dashboard "Open" button
// flow. Once the install's own ComfyUI window has opened (or it was already
// running), the install-less chooser host window closes itself.
//
// `useListAction` covers the same launch UX paths the Dashboard already
// uses: confirm modal, in-progress guard, port-conflict resolution via
// ProgressModal, telemetry, etc. Reusing it keeps the chooser pick from
// re-implementing launch semantics.
const { executeAction: executeChooserAction } = useListAction('chooser', {
  showProgress: handleShowProgress,
})

/** Pending close-on-launch subscription (fallback), so unmount can
 *  clean it up. Only set when the in-place attach claim is rejected
 *  by main and the chooser host falls back to the close+open swap. */
let pendingPickUnsub: (() => void) | null = null

/** Prepare the chooser host for a launch hand-off. First try to
 *  claim the host for in-place attach: when the launch event lands
 *  in main, `onLaunch` will attach the install to THIS host window
 *  instead of constructing a fresh one. If the claim is rejected
 *  (e.g. the install needs a unique browser partition), fall back
 *  to the stamp-bounds + close-on-instance-started swap so the user
 *  still gets the install's window at the chooser's bounds. */
async function prepareChooserHostHandoff(installationId: string): Promise<void> {
  const claimed = await window.api.claimAttachHost(installationId)
  if (claimed) return
  // Fallback. Visual continuity — stamp the chooser host's current
  // bounds onto the install's saved-bounds slot so its
  // freshly-constructed window opens at the chooser's position.
  await window.api.transferHostBoundsToInstall(installationId)
  // Subscribe BEFORE kicking off the launch so we don't miss a fast-
  // firing instance-started broadcast. The launch action runs via the
  // ProgressModal pipeline (showProgress: true) so executeAction
  // returns immediately after kicking it off — the actual completion
  // signal is the instance-started event coming back from main.
  pendingPickUnsub?.()
  pendingPickUnsub = window.api.onInstanceStarted((data) => {
    if (data.installationId !== installationId) return
    pendingPickUnsub?.()
    pendingPickUnsub = null
    // The install's own ComfyUI window has opened — chooser host is done.
    void window.api.closeHostWindow()
  })
}

async function handleChooserPick(installation: Installation): Promise<void> {
  // Already-running short-circuit, launch-action lookup, and in-place
  // attach claim all live in `performChooserLaunch`. Tile-click
  // semantics for the missing-launch-action case: bounce into the
  // new-install flow inside this same host so the user can resolve
  // the missing setup step without bouncing to a separate window.
  await performChooserLaunch(installation, () => { void switchPanel('new-install', 'chooser_pick') })
}

function handleChooserShowNewInstall(): void {
  // Empty-state CTA from the chooser — opens the new-install flow as
  // a Tier 3 takeover above the chooser body. Same install-less host
  // window; the user perceives a wizard step rather than a navigation
  // jump, and dismissing the takeover drops them right back into the
  // chooser tile they came from.
  void switchPanel('new-install', 'chooser')
}

function handleNavigateList(): void {
  // The install was removed from the list (e.g. deleted, migrated). The
  // ComfyUI window that hosts this panel no longer has an install backing
  // it, so ask main to close the parent window. Falls back to the
  // missing-install placeholder if the close fails for any reason
  // (e.g. window already torn down) — the onInstallationsChanged broadcast
  // wired into installationStore has already cleared the local record.
  if (installationId) {
    void window.api.closeComfyWindow(installationId)
  }
}

onMounted(async () => {
  await loadLocale()

  unsubLocale = window.api.onLocaleChanged((messages) => {
    mergeLocaleMessage('en', messages as Record<string, unknown>)
  })

  // Main can request a panel switch (e.g. from title-bar buttons, or when
  // the install lifecycle changes — main flips us to 'comfy-lifecycle' when
  // the instance stops so the Comfy tab body shows the right transient UI).
  // Flow panels (new-install / track / load-snapshot / quick-install) need
  // the imperative open() reset to run after mount, so funnel through
  // switchPanel() rather than assigning activePanel directly.
  unsubPanel = window.api.onPanelSwitch((data) => {
    if (VALID_PANELS.has(data.panel as PanelKey)) {
      void switchPanel(data.panel as PanelKey)
    }
  })

  // (Settings refetch on settings-changed lives inside SettingsView's
  // own `onMounted`/`onUnmounted`.)

  // Main consults the panel renderer before tearing down
  // the host window. Funnel the consult through `closeOverlay()` so a
  // Tier 2 progress / Tier 3 takeover op can prompt the user via the
  // standardised cancel-prompt copy. `closeOverlay` returns true when
  // the slot is empty or the user confirmed cancellation; false when
  // the user dismissed the prompt. We echo the boolean back to main
  // along with the original `requestId` so main can pair it with the
  // request that fired it.
  unsubCloseRequest = window.api.onCloseRequest(({ requestId }) => {
    // Ack synchronously so main extends its hung-renderer timeout —
    // the actual response can take arbitrary time when the user is
    // looking at a cancel-prompt confirmation modal, and the old
    // 5s response timeout was racing slow user input and force-
    // closing the window.
    window.api.ackCloseRequest({ requestId })
    void (async () => {
      const cleared = currentOverlay.value === null ? true : await closeOverlay()
      window.api.respondCloseRequest({ requestId, cleared })
    })()
  })

  // Auto-fire the restart prompt when an auto-off user-initiated
  // download finishes — closes the loop on the single-gesture flow
  // (Download → wait → Restart) without forcing the user to find the
  // pill again.
  unsubAppUpdatePromptRestart = window.api.onAppUpdatePromptRestart(({ version }) => {
    void showAppUpdateRestartPrompt(version || null)
  })

  // Surface user-initiated update failures (download/install) as an
  // alert. Background auto-on download errors stay silent (main
  // doesn't broadcast them on this channel).
  unsubAppUpdateUserActionFailed = window.api.onAppUpdateUserActionFailed(({ message }) => {
    void modal.alert({
      title: t('appUpdate.errorTitle'),
      message,
    })
  })

  // Main forwards a file-menu Skip Onboarding click here. Run the
  // same `markFirstUseCompleted` +
  // dismiss-takeover sequence the Cloud-branch pick uses; if the
  // overlay isn't a first-use takeover (defensive — main only sends
  // this when the menu surfaced the entry, which only happens in
  // `post-consent`) the dismiss is a no-op for the overlay slot but
  // the gate flip still has to land so the takeover doesn't auto-
  // remount on the next launch.
  unsubFirstUseSkip = window.api.onFirstUseSkip(() => {
    void completeFirstUseAndDismiss()
  })

  // Initialize stores / prefs needed by the embedded DetailModal that
  // backs the unified Settings modal's "ComfyUI Settings" tab.
  // installationStore wires its own onInstallationsChanged listener.
  await Promise.all([
    sessionStore.init(),
    installationStore.fetchInstallations(),
    launcherPrefs.loadPrefs(),
  ])

  // Release any panel-trigger-overlay handler that arrived during the
  // async bootstrap and parked on `bootstrapReady`. By this point the
  // installation store, session store, and locales are all populated,
  // so the unified Settings modal can render correctly on the first
  // install-update pill click.
  resolveBootstrap?.()
  resolveBootstrap = null

  // If the URL-driven initial panel mounts as an overlay (flow wizard
  // or unified Settings modal), kick that open now — script-setup
  // couldn't because the template hadn't rendered yet.
  if (FLOW_PANELS.has(initialPanel) || initialPanel === 'settings') {
    void switchPanel(initialPanel, 'url')
  }

  // First-use takeover auto-mounts when the persisted gate is still
  // false. Runs AFTER the URL-driven flow panel branch so a
  // `?panel=new-install` request still wins (e.g. when main re-routes
  // a chooser pick into new-install for an un-installed source); the
  // first-use takeover will replay on the next launch since
  // `firstUseCompleted` stays false until the explicit completion
  // path runs.
  if (!launcherPrefs.firstUseCompleted.value && !FLOW_PANELS.has(initialPanel)) {
    void openFirstUseTakeover()
  }
})

onUnmounted(() => {
  unsubPanel?.()
  unsubLocale?.()
  unsubCloseRequest?.()
  unsubFirstUseSkip?.()
  unsubAppUpdatePromptRestart?.()
  unsubAppUpdateUserActionFailed?.()
  pendingPickUnsub?.()
  sessionStore.dispose()
})
</script>

<template>
  <div class="panel-shell">
    <main class="panel-content">
      <div v-if="activePanel === 'comfy-lifecycle'" class="panel-comfy-lifecycle">
        <ComfyLifecycleView
          :installation="installation"
          :installation-id="installationId"
          @show-progress="handleShowProgress"
        />
      </div>

      <div v-else-if="activePanel === 'chooser'" class="panel-chooser">
        <ChooserView
          @pick="handleChooserPick"
          @show-new-install="handleChooserShowNewInstall"
          @show-progress="handleShowProgress"
        />
      </div>

    </main>

    <!-- Host-level overlay slot. One DOM node at a
         time, owned by `useOverlay`. Mounts either a Tier 1 popover,
         the in-flight progress modal (Tier 2), or one of the Tier 3
         takeovers (the four flow modals + the first-use takeover).
         The branches are mutually exclusive because `useOverlay` only
         ever holds one overlay in `current.value`.

         App-update is NOT in this chain — the title-bar app-update
         pill click pops a `useModal.confirm` modal (issue #488) that
         lives in the global ModalDialog mount below, not in the
         overlay slot. -->
    <!-- Tier 1 unified Settings modal. Mounted with `installation`
         carried by the overlay payload (chooser-card Manage uses
         the card's install, install-pill / waffle uses the host's
         install, install-less host's waffle entry passes null).
         The body underneath stays on chooser / comfy-lifecycle so
         dismissing returns there. -->
    <SettingsModal
      v-if="currentOverlay?.kind === 'settings'"
      :installation="currentOverlay.installation"
      :initial-tab="currentOverlay.initialTab"
      :initial-detail-tab="currentOverlay.initialDetailTab"
      :auto-action="currentOverlay.autoAction"
      :no-sidebar="currentOverlay.noSidebar"
      @close="dismissTakeoverDirect"
      @show-progress="handleShowProgress"
      @update:installation="handleUpdateInstallation"
      @navigate-list="handleNavigateList"
    />
    <!-- Tier 2 progress slot. ProgressModal owns its own backdrop via
         the unified Modal primitive. -->
    <ProgressModal
      v-else-if="currentOverlay?.kind === 'progress'"
      ref="progressRef"
      :installation-id="currentOverlay.installationId"
      @close="handleProgressClose"
    />

    <!-- Tier 3 binding modals. Each child component owns its own
         backdrop via the unified Modal primitive. -->
    <template v-else-if="currentOverlay?.kind === 'takeover'">
      <ProgressModal
        v-if="currentOverlay.component === 'update'"
        ref="progressRef"
        :installation-id="currentOverlay.installationId ?? ''"
        binding
        @close="handleProgressClose"
      />
      <NewInstallModal
        v-else-if="currentOverlay.component === 'new-install'"
        ref="newInstallRef"
        :hide-back-to-dashboard="chainingFirstUseToNewInstall"
        @close="handleNewInstallTakeoverClose"
        @navigate-list="handleNewInstallTakeoverClose"
        @show-progress="handleShowProgress"
      />
      <TrackModal
        v-else-if="currentOverlay.component === 'track'"
        ref="trackRef"
        @close="dismissTakeoverDirect"
        @navigate-list="dismissTakeoverDirect"
      />
      <LoadSnapshotModal
        v-else-if="currentOverlay.component === 'load-snapshot'"
        ref="loadSnapshotRef"
        @close="dismissTakeoverDirect"
        @show-progress="handleShowProgress"
      />
      <QuickInstallModal
        v-else-if="currentOverlay.component === 'quick-install'"
        ref="quickInstallRef"
        @close="dismissTakeoverDirect"
        @show-progress="handleShowProgress"
      />
      <FirstUseTakeover
        v-else-if="currentOverlay.component === 'first-use'"
        ref="firstUseRef"
        @complete-cloud="handleFirstUseComplete"
        @complete-skip="completeFirstUseAndDismiss"
        @chain-local="handleFirstUseChainLocal"
        @chain-migrate="handleFirstUseChainMigrate"
      />
    </template>

    <ModalDialog />
  </div>
</template>

<style scoped>
.panel-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

.panel-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* Match the launcher window's `.content` padding so tab-mode views
   * (SettingsView etc.) have the same gutter as in the standalone window. */
  padding: 24px 28px;
  overflow: hidden;
}

/* The comfy-lifecycle view fills its own background and the chooser
 * owns its own filter / grid padding (and needs the full panel height
 * so its grid can scroll vertically) — negate the panel-content
 * gutter for those branches. */
.panel-content:has(.panel-comfy-lifecycle),
.panel-content:has(.panel-chooser) {
  padding: 0;
}

.panel-comfy-lifecycle,
.panel-chooser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-placeholder {
  padding: 24px;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.6;
}

.panel-placeholder code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
