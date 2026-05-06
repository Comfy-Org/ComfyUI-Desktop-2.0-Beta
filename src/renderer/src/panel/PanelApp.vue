<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingsView from '../views/SettingsView.vue'
import DetailModal from '../views/DetailModal.vue'
import ProgressModal from '../views/ProgressModal.vue'
import ModalDialog from '../components/ModalDialog.vue'
import ComfyLifecycleView from './ComfyLifecycleView.vue'
import ChooserView from '../views/ChooserView.vue'
import DirectoriesView from '../views/DirectoriesView.vue'
import NewInstallModal from '../views/NewInstallModal.vue'
import TrackModal from '../views/TrackModal.vue'
import LoadSnapshotModal from '../views/LoadSnapshotModal.vue'
import QuickInstallModal from '../views/QuickInstallModal.vue'
import FirstUseTakeover from '../views/FirstUseTakeover.vue'
import UpdateBanner from '../components/UpdateBanner.vue'
import AppUpdatePopover from '../components/AppUpdatePopover.vue'
import DownloadsTrayPopover from '../components/DownloadsTrayPopover.vue'
import { useTheme } from '../composables/useTheme'
import { useSessionStore } from '../stores/sessionStore'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useListAction } from '../composables/useListAction'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useOverlay, type FlowComponent } from '../composables/useOverlay'
import type { ActionResult, Installation, ShowProgressOpts } from '../types/ipc'

/**
 * Body modes the panel WebContentsView can render. Mirrors the `BodyMode`
 * union in `src/main/index.ts` — `'comfy-lifecycle'` is the lifecycle UI
 * shown for the Comfy tab when no ComfyUI process is running, `'chooser'`
 * is the install-picker shown for the Comfy tab of an install-less host
 * window, the others are the title-bar pills that map directly to a panel.
 */
export type PanelKey =
  | 'comfy-lifecycle'
  | 'chooser'
  | 'install-settings'
  | 'launcher-settings'
  | 'directories'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

const VALID_PANELS: ReadonlySet<PanelKey> = new Set([
  'comfy-lifecycle',
  'chooser',
  'install-settings',
  'launcher-settings',
  'directories',
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/**
 * Panels that wrap a `*Modal` component which exposes an imperative
 * `open()` reset. Phase 3 §17 — these no longer mount as panel-body
 * branches; they mount in the host's takeover overlay slot (Tier 3)
 * via `useOverlay`. The set is still keyed on PanelKey because main
 * still addresses these as "panel switch" requests (URL `?panel=…`
 * and the `panel-switch` IPC) — `switchPanel` diverts them into
 * `openOverlay({ kind: 'takeover', component })` instead of assigning
 * `activePanel`.
 *
 * Each entry has a matching `*Ref` template ref so we can call the
 * imperative `open()` reset after the takeover mounts (form state
 * carries over otherwise — same reason the pre-§17 panel-body
 * branches needed the post-mount `open()`).
 */
const FLOW_PANELS: ReadonlySet<PanelKey> = new Set([
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

const { setLocaleMessage, locale } = useI18n()
useTheme()

const params = new URLSearchParams(window.location.search)
const installationId = params.get('installationId') || ''
/**
 * The default body panel for this host — the surface that sits
 * underneath any takeover overlay. Install-backed hosts default to
 * launcher-settings (matches the pre-Phase-3 title-bar Launcher
 * Settings pill behaviour), install-less hosts default to the chooser.
 * Used both for the initial mount (when the URL doesn't request a
 * specific panel) AND as the underlying body when the initial URL
 * panel is a flow-takeover (`?panel=new-install` etc.).
 */
function defaultBodyPanel(): PanelKey {
  return installationId ? 'launcher-settings' : 'chooser'
}
const initialPanel: PanelKey = ((): PanelKey => {
  const raw = params.get('panel')
  if (raw && VALID_PANELS.has(raw as PanelKey)) return raw as PanelKey
  return defaultBodyPanel()
})()

// `activePanel` is the underlying body. Flow keys are never assigned
// here — they mount in the takeover overlay slot instead (see
// `openFlowTakeover` and the post-mount `switchPanel(initialPanel)`
// in `onMounted` which routes `?panel=new-install` etc. through the
// overlay path).
const activePanel = ref<PanelKey>(
  FLOW_PANELS.has(initialPanel) ? defaultBodyPanel() : initialPanel,
)
const settingsRef = ref<InstanceType<typeof SettingsView> | null>(null)
const progressRef = ref<InstanceType<typeof ProgressModal> | null>(null)
const newInstallRef = ref<InstanceType<typeof NewInstallModal> | null>(null)
const trackRef = ref<InstanceType<typeof TrackModal> | null>(null)
const loadSnapshotRef = ref<InstanceType<typeof LoadSnapshotModal> | null>(null)
const quickInstallRef = ref<InstanceType<typeof QuickInstallModal> | null>(null)
const firstUseRef = ref<InstanceType<typeof FirstUseTakeover> | null>(null)

/**
 * Phase 3 §17 Step 4 — set when the first-use takeover's Local
 * branch chains into the new-install Tier 3 takeover. The new-install
 * modal emits `close` after a successful install (the same hook used
 * everywhere); when that fires while this flag is true the host
 * marks `firstUseCompleted` and clears the flag. A Cloud branch pick
 * marks completion immediately and never sets this flag, so the two
 * paths can't double-fire the pref write.
 */
const chainingFirstUseToNewInstall = ref(false)

/**
 * Post-Phase-3 polish (Track D item 4) — installation id of the
 * Standalone install that the first-use chain (new-install or
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
 * Host-level overlay slot (Phase 3 §17). Owns the in-flight progress
 * (`progress` kind) and Tier 3 takeovers (`takeover` kind — the four
 * flow modals plus the future first-use flow). Manage / Tier 1
 * overlays driven by ChooserView mount in ChooserView's own slot —
 * see `useOverlay` for the tier-collision rules. The `current` ref is
 * destructured to a top-level binding so the template can read it via
 * Vue's auto-unwrap.
 *
 * `tier` drives the title-bar inert flag — when a Tier 3 takeover is
 * mounted the title bar disables its file menu, install pill and
 * back/forward arrows so the user can't dismiss the takeover via
 * those affordances. See the watcher below.
 */
const { current: currentOverlay, tier, openOverlay, closeOverlay } = useOverlay()

/**
 * Modal-unification (Track M-2.1 / M-3) — class list for the Tier 3
 * takeover slot's wrapper div. Binding takeover-modals (first-use
 * post M-2.1, the four install-flow modals + update-while-running
 * post M-3) opt into:
 *   - `view-modal--opaque` so the backdrop reads as a fully-covering
 *     surface rather than a translucent overlay.
 *   - `is-binding-takeover-modal` so the legacy full-window
 *     `:deep(.view-modal-content)` override doesn't clobber the
 *     binding modal's `view-modal-content--takeover` width /
 *     centred-dialog chrome.
 * Every Tier 3 component is now a binding takeover-modal — the gate
 * is kept in computed shape so the wrapper class set is local to one
 * place (and the M-4 retirement of the legacy `:not(...)` override
 * has a single edit point).
 */
const takeoverWrapperClasses = computed<Record<string, boolean>>(() => {
  const isBinding = currentOverlay.value?.kind === 'takeover'
  return {
    'view-modal--opaque': isBinding,
    'is-binding-takeover-modal': isBinding,
  }
})

watch(tier, (newTier, oldTier) => {
  // Only signal main on transitions into/out of the takeover tier —
  // shifting between Tier 1 ↔ Tier 2 doesn't change the title-bar
  // state, so we skip the redundant IPC.
  const wasTakeover = oldTier === 3
  const isTakeover = newTier === 3
  if (wasTakeover === isTakeover) return
  window.api.setTitleBarInert(isTakeover)
})

// installationStore.fetchInstallations() is wired to onInstallationsChanged
// inside the store itself, so the panel just needs to read from it.
const installation = computed<Installation | null>(
  () => (installationId ? installationStore.getById(installationId) ?? null : null),
)

let unsubPanel: (() => void) | null = null
let unsubLocale: (() => void) | null = null
let unsubSettings: (() => void) | null = null
let unsubCloseRequest: (() => void) | null = null
let unsubPanelTriggerOverlay: (() => void) | null = null
let unsubFirstUseSkip: (() => void) | null = null

async function loadLocale(): Promise<void> {
  const messages = await window.api.getLocaleMessages()
  setLocaleMessage('en', messages)
  locale.value = 'en'
}

/**
 * `show-progress` from any panel body (DetailModal, ChooserView,
 * NewInstallModal, …). Routes through the host's overlay slot so the
 * Tier 2 collision rules apply — replacing one in-flight progress op
 * with another prompts the user to cancel via the standardised copy.
 *
 * Step 5 §10 — classifier rule §4: if the install is currently running,
 * the operation must end in the running app (Update Now restarts after
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
  // Track D item 4 — capture the operation's installation id when a
  // first-use chain is in flight (new-install or migrate). The
  // progressStore watcher above auto-launches the resulting install
  // once the op finishes successfully. New-install ops carry the
  // new install's id directly; migrate ops carry the legacy install's
  // id and the watcher resolves the resulting Standalone install
  // from the store after the op finishes. Only the first chained op
  // captures the id — subsequent show-progress calls (e.g. user
  // re-opens an in-progress modal) leave it untouched.
  if (chainingFirstUseToNewInstall.value && pendingFirstUseAutoLaunchId.value === null) {
    pendingFirstUseAutoLaunchId.value = opts.installationId
  }
  const isRunning = sessionStore.isRunning(opts.installationId)
  const ok = await openOverlay(
    isRunning
      ? {
          kind: 'takeover',
          component: 'update',
          installationId: opts.installationId,
          operationName,
        }
      : {
          kind: 'progress',
          installationId: opts.installationId,
          operationName,
        },
  )
  if (!ok) return
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
 * Phase 3 §17 — open one of the four flow modals as a Tier 3 takeover
 * overlay (full-window body sitting above the underlying panel). The
 * imperative `open()` reset on each *Modal ref runs after the takeover
 * mounts so form state always starts fresh, the same way the pre-§17
 * panel-body branches reset on (re)entry.
 *
 * Returns silently if `openOverlay` was rejected (the user dismissed
 * the cancel-prompt that fires when an in-flight Tier 2 progress op
 * is being pre-empted — see `useOverlay`'s tier-collision rules).
 */
async function openFlowTakeover(component: FlowComponent): Promise<void> {
  const ok = await openOverlay({ kind: 'takeover', component })
  if (!ok) return
  // Wait for the v-if branch in the takeover slot to mount the
  // component before reaching for its ref.
  await nextTick()
  if (component === 'new-install') await newInstallRef.value?.open()
  else if (component === 'track') trackRef.value?.open()
  else if (component === 'load-snapshot') loadSnapshotRef.value?.open()
  else if (component === 'quick-install') await quickInstallRef.value?.open()
}

/**
 * Phase 3 §17 Step 4 — open the first-use takeover. Same shape as
 * `openFlowTakeover` but the component identifier is the free-form
 * `'first-use'` string (TakeoverOverlay.component is intentionally
 * untyped — see useOverlay.ts) and the post-mount reset goes through
 * the FirstUseTakeover ref's own `open()`. Auto-mounted from
 * `onMounted` when `launcherPrefs.firstUseCompleted` is false; not
 * routed through `switchPanel` because there's no URL/IPC entry point
 * for it (the gate is purely the persisted pref).
 *
 * Post-Phase-3 polish — fetches the categorised first-use state from
 * main (`getFirstUseState`) so the takeover can suppress the cloud-
 * vs-local pick step for returning users (any non-cloud, non-legacy-
 * desktop install present means the user has already used the
 * launcher; don't re-litigate the choice). The fetch runs in parallel
 * with the overlay mount — by the time `nextTick` resolves and we
 * reach for the imperative `open()` the IPC has usually already
 * settled, so the await is effectively free.
 */
async function openFirstUseTakeover(): Promise<void> {
  const statePromise = window.api.getFirstUseState()
    .catch(() => ({ skipPick: false, hasLegacyDesktop: false }))
  // Modal-unification (Track M-2.4) — opt the takeover into the
  // dedicated "Quit setup?" cancel-prompt copy so the OS-X consult
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
 * Step 5 §16 — bypass the takeover→null cancel-prompt for
 * renderer-internal intentional close paths (✕ on a takeover,
 * post-completion auto-close). The prompt belongs to the
 * consult-from-main `onCloseRequest` path; firing it on a user's
 * own ✕ click would be a redundant double-confirm. Mirrors the
 * `handleProgressClose` direct-mutation pattern.
 */
function dismissTakeoverDirect(): void {
  // Modal-unification (Track M-2.2) — whenever a Tier 3 overlay is
  // cleared from the renderer side, the host's first-use mode must
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
  currentOverlay.value = null
}

/** Modal-unification (Track M-2.2) — shared completion helper. The
 *  Cloud-branch pick (`handleFirstUseComplete`) and the file-menu
 *  Skip Onboarding entry (`onFirstUseSkip` listener) and the
 *  new-install chain close (`handleNewInstallTakeoverClose`) all run
 *  the same `markFirstUseCompleted` → dismiss sequence; extracting
 *  the pair keeps them in sync if the gate flip ever needs extra
 *  state cleanup (e.g. a future telemetry event). */
async function completeFirstUseAndDismiss(): Promise<void> {
  await launcherPrefs.markFirstUseCompleted()
  dismissTakeoverDirect()
}

/** First-use takeover Cloud-branch pick — one-shot completion. The
 *  chooser body underneath is what the user lands on; we additionally
 *  auto-launch the always-present Cloud install (Track D item 4) so
 *  the user reaches a running ComfyUI as the natural endpoint of
 *  first-use without having to click play again. The launch goes
 *  through the same `useListAction` pipeline the chooser uses
 *  (close-host-window-on-instance-started, etc.). If the cloud
 *  install can't be found for any reason we still mark complete and
 *  close the takeover — the chooser body underneath is the fallback. */
async function handleFirstUseComplete(): Promise<void> {
  chainingFirstUseToNewInstall.value = false
  await completeFirstUseAndDismiss()
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
    void launchInstallationAfterFirstUse(cloud)
  }
}

/** First-use takeover Local-branch pick — chain into the new-install
 *  Tier 3 takeover. The Tier 3 → Tier 3 swap is silent in
 *  `useOverlay`, so the first-use takeover unmounts as the
 *  new-install takeover mounts. The completion flip is deferred to
 *  the new-install close path (see `handleNewInstallTakeoverClose`). */
function handleFirstUseChainLocal(): void {
  chainingFirstUseToNewInstall.value = true
  pendingFirstUseAutoLaunchId.value = null
  void switchPanel('new-install')
}

/** First-use takeover migrate-branch pick (Track D item 5) — runs
 *  the migrate-to-standalone action against the auto-tracked Legacy
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
    // Don't clear `chainingFirstUseToNewInstall` yet — the auto-launch
    // watcher uses it together with `pendingFirstUseAutoLaunchId` to
    // decide whether to fire. The watcher clears both after launch.
  }
  // Note: this close path always swaps OUT of a `'new-install'` Tier 3
  // takeover, never directly out of `'first-use'` — the chain replaced
  // the FirstUseTakeover overlay before mount. So there's no first-use
  // mode to clear here; FirstUseTakeover.vue's onUnmounted handler
  // already pushed `'none'` when it was swapped out at chain-local
  // time.
  dismissTakeoverDirect()
}

/** Track D item 4 — fire the install's launch action through the
 *  same `useListAction` pipeline ChooserView uses for tile clicks.
 *  Mirrors the `handleChooserPick` shape (port-conflict resolution,
 *  telemetry, close-host-window-on-instance-started) so first-use
 *  ends with a running ComfyUI in its own window and the dashboard
 *  host shuts down behind it. */
async function launchInstallationAfterFirstUse(installation: Installation): Promise<void> {
  if (sessionStore.isRunning(installation.id)) {
    await window.api.focusComfyWindow(installation.id)
    void window.api.closeHostWindow()
    return
  }
  const actions = await window.api.getListActions(installation.id)
  const launchAction = actions.find((a) => a.id === 'launch')
    ?? actions.find((a) => a.style === 'primary')
    ?? null
  if (!launchAction) return
  await window.api.transferHostBoundsToInstall(installation.id)
  pendingPickUnsub?.()
  pendingPickUnsub = window.api.onInstanceStarted((data) => {
    if (data.installationId !== installation.id) return
    pendingPickUnsub?.()
    pendingPickUnsub = null
    void window.api.closeHostWindow()
  })
  await executeChooserAction(installation, launchAction)
}

/** Track D item 4 — watch progressStore for the new-install /
 *  migration op finishing and auto-launch the resulting Standalone
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
    if (!id) return
    if (op.cancelRequested || op.error || !op.result?.ok) return
    // The migrate-to-standalone op runs against the legacy install
    // but produces a fresh Standalone install — wait for the store
    // to reflect the new install, then launch the most-recently-
    // created non-cloud, non-legacy local install (the migration's
    // result). For new-install ops, the captured id is the new
    // install's id directly so this branch resolves immediately.
    let inst = installationStore.installations.find((i) => i.id === id) ?? null
    if (!inst || inst.sourceId === 'desktop') {
      // Migration case — the captured id was the legacy install. Find
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
      void launchInstallationAfterFirstUse(inst)
    }
  },
  { deep: false },
)

/**
 * Switch the underlying panel body. Flow keys (`new-install` / `track`
 * / `load-snapshot` / `quick-install`) divert into the Tier 3
 * takeover overlay slot instead of swapping the body — see
 * `openFlowTakeover` for why.
 *
 * For non-flow keys: the assignment is idempotent — re-selecting the
 * already-active panel is a no-op, matching what the user perceives
 * (the title-bar pill click is just "go to this page", with no reset
 * semantics needed for tab-style views like Settings / Directories).
 */
async function switchPanel(panel: PanelKey): Promise<void> {
  if (FLOW_PANELS.has(panel)) {
    await openFlowTakeover(panel as FlowComponent)
    return
  }
  activePanel.value = panel
}

function handleUpdateInstallation(inst: Installation): void {
  // Optimistic local update for snappier UX while the broadcast-driven
  // refetch is in flight (e.g. rename via the editable title).
  const idx = installationStore.installations.findIndex((i) => i.id === inst.id)
  if (idx >= 0) installationStore.installations.splice(idx, 1, inst)
}

/** DetailModal close (✕) when mounted as the install-settings panel
 *  body. Phase 3 §17 dropped DetailModal's `inline` prop; the parent
 *  decides what `close` means. For install-settings we ask main to
 *  reset the host window's panel-history stack so the body returns
 *  to the comfy/chooser root, matching the pre-§17 inline behaviour. */
function handleInstallSettingsClose(): void {
  window.api.closeCurrentPanel()
}

// --- Chooser handlers (install-less host window only) ---
//
// Phase 3 step 2d — chooser pick triggers the install's launch action
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

/** Pending close-on-launch subscription, so unmount can clean it up. */
let pendingPickUnsub: (() => void) | null = null

async function handleChooserPick(installation: Installation): Promise<void> {
  // Already running with an open window — focus that window and retire
  // the chooser host. No need to involve the launch action.
  if (sessionStore.isRunning(installation.id)) {
    await window.api.focusComfyWindow(installation.id)
    void window.api.closeHostWindow()
    return
  }

  // Otherwise look up the launch action (sources expose it as their
  // primary list action, e.g. 'launch' for standalone, 'connect' for
  // url-based sources) and run it through the standard pipeline.
  const actions = await window.api.getListActions(installation.id)
  const launchAction = actions.find((a) => a.id === 'launch')
    ?? actions.find((a) => a.style === 'primary')
    ?? null
  if (!launchAction) {
    // Source has no launch path (e.g. the install isn't installed yet).
    // Fall back to the new-install flow inside the host window so the
    // user can resolve the missing setup step without bouncing to the
    // launcher window (which is going away in this phase).
    void switchPanel('new-install')
    return
  }

  // Visual continuity — stamp the chooser host's current bounds onto the
  // install's saved-bounds slot BEFORE the launch, so the install's own
  // window opens exactly where the chooser was. The user perceives a
  // swap-in-place even though it's structurally close+open.
  await window.api.transferHostBoundsToInstall(installation.id)

  // Subscribe BEFORE kicking off the launch so we don't miss a
  // fast-firing instance-started broadcast. The launch action runs via
  // the ProgressModal pipeline (showProgress: true) so executeAction
  // returns immediately after kicking it off — the actual completion
  // signal is the instance-started event coming back from main.
  pendingPickUnsub?.()
  pendingPickUnsub = window.api.onInstanceStarted((data) => {
    if (data.installationId !== installation.id) return
    pendingPickUnsub?.()
    pendingPickUnsub = null
    // The install's own ComfyUI window has opened — chooser host is done.
    void window.api.closeHostWindow()
  })

  await executeChooserAction(installation, launchAction)
}

function handleChooserShowNewInstall(): void {
  // Empty-state CTA from the chooser — opens the new-install flow as
  // a Tier 3 takeover above the chooser body. Same install-less host
  // window; the user perceives a wizard step rather than a navigation
  // jump, and dismissing the takeover drops them right back into the
  // chooser tile they came from.
  void switchPanel('new-install')
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
    setLocaleMessage('en', messages as Record<string, unknown>)
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

  // Settings broadcast — refetch the launcher settings sections so panels
  // opened in multiple windows stay in sync.
  unsubSettings = window.api.onSettingsChanged(() => {
    settingsRef.value?.loadSettings()
  })

  // Step 5 §16 — main consults the panel renderer before tearing down
  // the host window. Funnel the consult through `closeOverlay()` so a
  // Tier 2 progress / Tier 3 takeover op can prompt the user via the
  // standardised cancel-prompt copy. `closeOverlay` returns true when
  // the slot is empty or the user confirmed cancellation; false when
  // the user dismissed the prompt. We echo the boolean back to main
  // along with the original `requestId` so main can pair it with the
  // request that fired it.
  unsubCloseRequest = window.api.onCloseRequest(({ requestId }) => {
    void (async () => {
      const cleared = currentOverlay.value === null ? true : await closeOverlay()
      window.api.respondCloseRequest({ requestId, cleared })
    })()
  })

  // Phase 3 §18 — main forwards a title-bar status pill click here.
  // The renderer routes each kind through `useOverlay.openOverlay`:
  //   - `'app-update'` → Tier 1 popover (AppUpdatePopover) reading
  //     state from the shared `useAppUpdateState` composable.
  //   - `'install-update'` → Manage overlay (DetailModal) on the
  //     update tab, scoped to the carried `installationId`. The
  //     install-update pill is suppressed in main on install-less
  //     hosts but we re-validate the id here defensively (the
  //     subscription is the same in both host kinds).
  unsubPanelTriggerOverlay = window.api.onPanelTriggerOverlay((payload) => {
    void (async () => {
      if (payload.kind === 'app-update') {
        await openOverlay({ kind: 'app-update' })
        return
      }
      if (payload.kind === 'install-update') {
        const id = payload.installationId
        if (!id || id !== installationId) return
        const inst = installationStore.getById(id)
        if (!inst) return
        await openOverlay({
          kind: 'manage',
          installation: inst,
          initialTab: 'update',
        })
        return
      }
      if (payload.kind === 'downloads') {
        // Track F — title-bar downloads tray click. Mounts the
        // DownloadsTrayPopover at Tier 1; the popover reads its
        // data from the renderer's `downloadStore` so no extra
        // payload is needed.
        await openOverlay({ kind: 'downloads' })
      }
    })()
  })

  // Modal-unification (Track M-2.2) — main forwards a file-menu Skip
  // Onboarding click here. Run the same `markFirstUseCompleted` +
  // dismiss-takeover sequence the Cloud-branch pick uses; if the
  // overlay isn't a first-use takeover (defensive — main only sends
  // this when the menu surfaced the entry, which only happens in
  // `post-consent`) the dismiss is a no-op for the overlay slot but
  // the gate flip still has to land so the takeover doesn't auto-
  // remount on the next launch.
  unsubFirstUseSkip = window.api.onFirstUseSkip(() => {
    void completeFirstUseAndDismiss()
  })

  // Initialize stores / prefs needed by the install-settings DetailModal.
  // installationStore wires its own onInstallationsChanged listener.
  await Promise.all([
    sessionStore.init(),
    installationStore.fetchInstallations(),
    launcherPrefs.loadPrefs(),
  ])

  // If the URL-driven initial panel is a flow panel, run its open()
  // reset now that the component has mounted (the script-setup branch
  // assigned activePanel before the template rendered, so the modal
  // refs weren't populated yet).
  if (FLOW_PANELS.has(initialPanel)) {
    void switchPanel(initialPanel)
  }

  // Phase 3 §17 Step 4 — first-use takeover auto-mounts when the
  // persisted gate is still false. Runs AFTER the URL-driven flow
  // panel branch so a `?panel=new-install` request still wins (e.g.
  // when main re-routes a chooser pick into new-install for an
  // un-installed source); the first-use takeover will replay on the
  // next launch since `firstUseCompleted` stays false until the
  // explicit completion path runs.
  if (!launcherPrefs.firstUseCompleted.value && !FLOW_PANELS.has(initialPanel)) {
    void openFirstUseTakeover()
  }
})

onUnmounted(() => {
  unsubPanel?.()
  unsubLocale?.()
  unsubSettings?.()
  unsubCloseRequest?.()
  unsubPanelTriggerOverlay?.()
  unsubFirstUseSkip?.()
  pendingPickUnsub?.()
  sessionStore.dispose()
})
</script>

<template>
  <div class="panel-shell">
    <!-- Update banner — listens to `update-available` / `update-error`
         broadcasts from the updater module. Mirrored from the launcher
         window's App.vue so the install pill caret's "Check for Updates"
         entry has a place to surface its result inside the host window
         (Phase 3: launcher window goes away). The banner is auto-hide
         when no update info is present, so this row renders nothing in
         the steady state. -->
    <UpdateBanner />

    <main class="panel-content">
      <SettingsView v-if="activePanel === 'launcher-settings'" ref="settingsRef" />

      <DirectoriesView v-else-if="activePanel === 'directories'" />

      <div v-else-if="activePanel === 'install-settings'" class="panel-install-settings">
        <DetailModal
          v-if="installation"
          :installation="installation"
          @close="handleInstallSettingsClose"
          @show-progress="handleShowProgress"
          @navigate-list="handleNavigateList"
          @update:installation="handleUpdateInstallation"
        />
        <div v-else class="panel-placeholder">
          <p v-if="installationStore.loading">{{ $t('common.loading') }}</p>
          <p v-else>
            {{ $t('titleBar.installationLabel') }}:
            <code>{{ installationId }}</code>
          </p>
        </div>
      </div>

      <div v-else-if="activePanel === 'comfy-lifecycle'" class="panel-comfy-lifecycle">
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

    <!-- Host-level overlay slot (Phase 3 §17). One DOM node at a
         time, owned by `useOverlay`. Mounts either the in-flight
         progress modal (Tier 2 — non-app-ending ops) or one of the
         Tier 3 takeovers (the four flow modals; Step 4 will add the
         first-use takeover here too). The two branches are mutually
         exclusive because `useOverlay` only ever holds one overlay
         in `current.value`.

         Phase 3 §18 — Tier 1 slots `app-update` (popover sourced from
         the title-bar app-update pill) and `manage` (DetailModal
         routed from the title-bar install-update pill, opened on the
         update tab) sit at the top of the v-if/v-else-if chain. Tier 1
         loses to Tier 2/3 in `useOverlay`'s collision rules, so the
         in-flight progress / takeover branches below pre-empt these
         silently when they fire concurrently. -->
    <AppUpdatePopover
      v-if="currentOverlay?.kind === 'app-update'"
      @close="dismissTakeoverDirect"
    />
    <!-- Track F — Tier 1 downloads tray popover surfaced from the
         title-bar tray. Reads its data from the shared `downloadStore`
         (same source the legacy `DownloadsPanel` consumes) so the
         tray and any other downloads surface never disagree. Click-
         away dismissal is handled the same way as `AppUpdatePopover`:
         `dismissTakeoverDirect` skips the cancel-prompt because
         closing the popover only hides the overlay; downloads keep
         running and the next broadcast repaints if the user reopens. -->
    <DownloadsTrayPopover
      v-else-if="currentOverlay?.kind === 'downloads'"
      @close="dismissTakeoverDirect"
    />
    <div
      v-else-if="currentOverlay?.kind === 'manage'"
      class="view-modal active"
      data-overlay-key="manage"
    >
      <DetailModal
        :installation="currentOverlay.installation"
        :initial-tab="currentOverlay.initialTab"
        :auto-action="currentOverlay.autoAction"
        @close="dismissTakeoverDirect"
        @show-progress="handleShowProgress"
      />
    </div>
    <div
      v-else-if="currentOverlay?.kind === 'progress'"
      class="view-modal active"
      data-overlay-key="progress"
    >
      <ProgressModal
        ref="progressRef"
        :installation-id="currentOverlay.installationId"
        @close="handleProgressClose"
      />
    </div>

    <!-- Tier 3 takeover slot. The four flow modals share the same
         shell — the underlying panel body (chooser / launcher-settings)
         stays mounted underneath, so `closeOverlay` returns the user
         to wherever they came from without us having to remember it.
         Step 5 §10 adds the `'update'` component which mounts the same
         `ProgressModal` as the Tier 2 progress slot but with full-window
         takeover styling (the `[data-overlay-key="takeover"]` :deep
         override on `.view-modal-content` makes it span the panel area).
         The `progressRef` template ref resolves to whichever
         ProgressModal is currently mounted — the two slots are mutually
         exclusive via the `v-if` chain. -->
    <div
      v-else-if="currentOverlay?.kind === 'takeover'"
      class="view-modal active"
      :class="takeoverWrapperClasses"
      data-overlay-key="takeover"
    >
      <ProgressModal
        v-if="currentOverlay.component === 'update'"
        ref="progressRef"
        :installation-id="currentOverlay.installationId ?? ''"
        takeover-chrome
        @close="handleProgressClose"
      />
      <NewInstallModal
        v-else-if="currentOverlay.component === 'new-install'"
        ref="newInstallRef"
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
        @complete="handleFirstUseComplete"
        @chain-local="handleFirstUseChainLocal"
        @chain-migrate="handleFirstUseChainMigrate"
      />
    </div>

    <ModalDialog />
  </div>
</template>

<style scoped>
.panel-shell {
  /* The panel WebContentsView lives BELOW the ComfyUI window's title bar
   * (which is its own WebContentsView). The panel renderer therefore has no
   * title bar of its own — neutralize the global --titlebar-height inset so
   * overlay modals (ProgressModal etc.) span the full panel area. */
  --titlebar-height: 0px;
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

/* Install-settings hosts an inline DetailModal and the comfy-lifecycle view
 * fills its own background — both own their padding, so negate the
 * panel-content gutter for those branches. The chooser owns its own
 * filter / grid padding and needs the full panel height so its grid
 * can scroll vertically. */
.panel-content:has(.panel-install-settings),
.panel-content:has(.panel-comfy-lifecycle),
.panel-content:has(.panel-chooser) {
  padding: 0;
}

.panel-install-settings,
.panel-comfy-lifecycle,
.panel-chooser {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Tier 3 takeover slot (Phase 3 §17). The four flow modals reuse the
 * launcher window's modal components (`*Modal.vue` with a
 * `.view-modal-content` root). When mounted as a takeover they should
 * fill the panel area instead of floating with a max-width dialog
 * box, so neutralize the modal sizing and chrome — same shape as the
 * pre-§17 `.panel-flow` :deep override that lived alongside the
 * panel-body branches. The `data-overlay-key` selector keeps this
 * scoped to the takeover slot only; the progress-overlay slot still
 * renders its ProgressModal as a centred dialog.
 *
 * Modal-unification (Track M-2.1) — binding takeover-modals (first-use,
 * and later the install-flow modals in M-3) opt OUT of the full-window
 * override via `is-binding-takeover-modal` so they can render as
 * centred dialogs constrained by `view-modal-content--takeover`
 * (1000px max). Once every flow modal has migrated, this override
 * (and the legacy class set on the wrapper) goes away in M-3/M-4. */
[data-overlay-key="takeover"]:not(.is-binding-takeover-modal) :deep(.view-modal-content) {
  width: 100%;
  max-width: none;
  height: 100%;
  border-radius: 0;
  box-shadow: none;
  margin: 0;
  background: var(--bg);
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
