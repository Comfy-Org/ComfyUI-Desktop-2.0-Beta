import { nextTick, ref, type ComputedRef, type Ref } from 'vue'
import type ProgressModal from '../views/ProgressModal.vue'
import type NewInstallModal from '../views/NewInstallModal.vue'
import type TrackModal from '../views/TrackModal.vue'
import type LoadSnapshotModal from '../views/LoadSnapshotModal.vue'
import type QuickInstallModal from '../views/QuickInstallModal.vue'
import type FirstUseTakeover from '../views/FirstUseTakeover.vue'
import { useOverlay, type FlowComponent } from '../composables/useOverlay'
import { useProgressStore } from '../stores/progressStore'
import { useSessionStore } from '../stores/sessionStore'
import { emitTelemetryAction } from '../lib/telemetry'
import type { ActionResult, Installation, ShowProgressOpts } from '../types/ipc'

// Body modes the panel WebContentsView can render. Mirrors `BodyMode`
// in main; `'comfy'` is admitted so the renderer can reflect main's
// activePanel after a drawer close.
export type PanelKey =
  | 'comfy'
  | 'comfy-lifecycle'
  | 'chooser'
  | 'settings'
  | 'settings-v2'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'quick-install'

const VALID_PANELS: ReadonlySet<PanelKey> = new Set([
  'comfy',
  'comfy-lifecycle',
  'chooser',
  'settings',
  'settings-v2',
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/**
 * Panels that wrap a `*Modal` component with an imperative `open()`
 * reset. These mount in the host's takeover overlay slot (Tier 3) via
 * `useOverlay` rather than as a body branch. Still keyed on `PanelKey`
 * because main addresses these as panel-switch requests (URL
 * `?panel=…` and the `panel-switch` IPC) — `switchPanel` diverts them
 * into `openOverlay({ kind: 'takeover', component })` instead of
 * assigning `activePanel`.
 */
const FLOW_PANELS: ReadonlySet<PanelKey> = new Set([
  'new-install',
  'track',
  'load-snapshot',
  'quick-install',
])

/** Stable `flow:` strings for `desktop2.install.flow.opened`. */
const FLOW_TELEMETRY_NAMES: Record<FlowComponent, string> = {
  'new-install': 'new_install',
  'quick-install': 'quick_install',
  track: 'track_existing',
  'load-snapshot': 'load_snapshot',
}

export function isValidPanel(raw: string | null | undefined): raw is PanelKey {
  return !!raw && VALID_PANELS.has(raw as PanelKey)
}

export function isFlowPanel(panel: PanelKey): boolean {
  return FLOW_PANELS.has(panel)
}

export interface FirstUseChainHooks {
  /** True when the first-use → new-install chain is in flight. Forces
   *  opaque takeover chrome on the next progress overlay so the dashboard
   *  doesn't flash through the Tier 3 → Tier 2 swap. */
  shouldForceTakeover: () => boolean
  /** Capture the first chained op's installationId and flip the
   *  persisted first-use gate. Called once per chain at the moment the
   *  install/migrate op begins. */
  onShowProgress: (opts: ShowProgressOpts) => void
  /** Read-and-clear: returns true if the next new-install takeover open
   *  should surface a Back link in its Configure footer (chain reached
   *  the new-install screen via Local → Start Fresh). Called by
   *  `openFlowTakeover` right before `newInstallRef.value?.open(...)`. */
  consumeCameFromLocalBranch: () => boolean
}

export interface UsePanelOverlaysOpts {
  installationId: string
  installation: ComputedRef<Installation | null>
  /** Hand-off subscription used by `handleShowProgress` when the
   *  in-flight op will end in a freshly-launched comfy window on an
   *  install-less host. Optional: install-backed hosts pass nothing. */
  prepareChooserHostHandoff?: (installationId: string) => Promise<void>
  /** Optional first-use chain integration — see `FirstUseChainHooks`. */
  firstUseChain?: FirstUseChainHooks
  // Template refs declared by the parent and bound via `ref="…"`.
  // Owned by the parent so vue-tsc can see them as used by the
  // template (destructuring out of the composable hides the binding
  // and trips `noUnusedLocals`).
  progressRef: Ref<InstanceType<typeof ProgressModal> | null>
  newInstallRef: Ref<InstanceType<typeof NewInstallModal> | null>
  trackRef: Ref<InstanceType<typeof TrackModal> | null>
  loadSnapshotRef: Ref<InstanceType<typeof LoadSnapshotModal> | null>
  quickInstallRef: Ref<InstanceType<typeof QuickInstallModal> | null>
  firstUseRef: Ref<InstanceType<typeof FirstUseTakeover> | null>
}

export interface UsePanelOverlaysApi {
  // State / overlay slot proxied from `useOverlay`.
  activePanel: Ref<PanelKey>
  initialPanel: PanelKey
  defaultBodyPanel: () => PanelKey
  currentOverlay: ReturnType<typeof useOverlay>['current']
  openOverlay: ReturnType<typeof useOverlay>['openOverlay']
  closeOverlay: ReturnType<typeof useOverlay>['closeOverlay']

  // Helpers.
  handleShowProgress: (opts: ShowProgressOpts) => Promise<void>
  handleProgressClose: () => void
  openFlowTakeover: (component: FlowComponent, entrypoint: string) => Promise<void>
  openFirstUseTakeover: (opts?: {
    initialStep?: 'consent' | 'pick' | 'localBranch'
  }) => Promise<void>
  dismissTakeoverDirect: () => void
  switchPanel: (panel: PanelKey, entrypoint?: string) => Promise<void>
}

/**
 * Owns the panel host's overlay slot and the Tier 2 / Tier 3 helpers
 * that mount things into it. Composed by `PanelApp.vue` so the
 * progress + takeover plumbing isn't redeclared inline.
 *
 * The `useOverlay()` slot is a module singleton, so `useChooserHandoff`
 * and `useFirstUseChain` can also call `useOverlay()` and operate on
 * the same `currentOverlay` without threading it through opts.
 */
export function usePanelOverlays(opts: UsePanelOverlaysOpts): UsePanelOverlaysApi {
  const {
    installationId,
    installation,
    progressRef,
    newInstallRef,
    trackRef,
    loadSnapshotRef,
    quickInstallRef,
    firstUseRef,
  } = opts
  const sessionStore = useSessionStore()
  const progressStore = useProgressStore()
  const { current: currentOverlay, openOverlay, closeOverlay } = useOverlay()

  const defaultBodyPanel = (): PanelKey => (installationId ? 'comfy-lifecycle' : 'chooser')

  const params = new URLSearchParams(window.location.search)
  const initialPanel: PanelKey = ((): PanelKey => {
    const raw = params.get('panel')
    if (isValidPanel(raw)) return raw
    return defaultBodyPanel()
  })()

  const activePanel = ref<PanelKey>(
    FLOW_PANELS.has(initialPanel) || initialPanel === 'settings' || initialPanel === 'settings-v2'
      ? defaultBodyPanel()
      : initialPanel,
  )

  /**
   * `show-progress` from any panel body. Routes through the host's
   * overlay slot so the Tier 2 collision rules apply; an in-flight
   * progress op being replaced prompts the user via the standardised
   * cancel-prompt copy.
   *
   * If the install is currently running, the operation must end in
   * the running app (Update Now restarts after applying), so route as
   * a Tier 3 takeover. Both branches mount the same `ProgressModal`
   * (one ref, since the v-if/v-else-if slots are mutually exclusive)
   * — only the wrapper tier and full-window styling differ.
   */
  async function handleShowProgress(showOpts: ShowProgressOpts): Promise<void> {
    // Manage→Progress restoration relies on the title carrying the
    // operation name (e.g. `"Updating ComfyUI — Local install"`); strip
    // the install suffix for the cancel-prompt copy so the prompt reads
    // `Cancel "Updating ComfyUI"?` instead of leaking the install name.
    const operationName = showOpts.title.split(' — ')[0] || showOpts.title
    opts.firstUseChain?.onShowProgress(showOpts)
    const isRunning = sessionStore.isRunning(showOpts.installationId)
    // Any op that will end in a freshly-launched / re-launched ComfyUI
    // window. Routed as a Tier 3 takeover with brand chrome so the
    // user sees the same loading screen regardless of where the launch
    // was initiated (chooser tile, DetailModal, ComfyUI Settings drawer,
    // picker Open/Restart, first-use chain). `prepareChooserHostHandoff`
    // further down is still gated on the install-less host case so the
    // chooser host close-on-instance-started behaviour only fires when
    // it should.
    const isLaunchLikeOp = showOpts.triggersInstanceStart === true
    // Install ops that opted into auto-launch (every non-first-use
    // install entry point now sets this). Route through the brand
    // takeover so the install bar and the subsequent launch sequence
    // (security scan → starting server) share one continuous Tier 3
    // screen. The auto-launch fires from `useFirstUseChain`'s watcher
    // when the install op finishes; the launch op carries
    // `triggersInstanceStart`, so the silent Tier 3 → Tier 3 swap keeps
    // the brand chrome in place across the handoff.
    const isAutoLaunchInstall = showOpts.autoLaunchOnFinish === true
    // Keep opaque takeover chrome alive when first-use is chaining into
    // the install + auto-launch sequence — without this the swap from
    // the new-install Tier 3 takeover to a Tier 2 progress overlay
    // exposes the dashboard underneath, breaking the bootstrap UX.
    const useTakeover =
      isRunning ||
      isLaunchLikeOp ||
      isAutoLaunchInstall ||
      (opts.firstUseChain?.shouldForceTakeover() ?? false)
    // Brand chrome on every launch-class op (consolidating chooser-tile,
    // DetailModal Launch/Restart, drawer actions, picker launches), plus
    // the first-use chain's onboarding sequence and auto-launch installs
    // (so the bar shape and captions match across the install → launch
    // handoff). Update-while-running (`isRunning && !isLaunchLikeOp &&
    // !isAutoLaunchInstall`) keeps the original binding chrome because
    // the op is mutating the live install, not starting a new window.
    const useBrandChrome =
      isLaunchLikeOp ||
      isAutoLaunchInstall ||
      (opts.firstUseChain?.shouldForceTakeover() ?? false)
    // Wire `onCancel` so a window-close consult (or any other slot-
    // clearing transition that fires the cancel-prompt) actually
    // cancels the in-flight op in main rather than orphaning it via
    // window destruction. Mirrors ProgressModal's manual cancel
    // button (`handleCancel` → `progressStore.cancelOperation`).
    const onCancel = (): void => {
      progressStore.cancelOperation(showOpts.installationId)
    }
    const ok = await openOverlay(
      useTakeover
        ? {
            kind: 'takeover',
            component: 'update',
            installationId: showOpts.installationId,
            operationName,
            onCancel,
            brandChrome: useBrandChrome,
          }
        : {
            kind: 'progress',
            installationId: showOpts.installationId,
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
    // without going through `prepareChooserHostHandoff`.
    if (showOpts.triggersInstanceStart && !installationId && opts.prepareChooserHostHandoff) {
      await opts.prepareChooserHostHandoff(showOpts.installationId)
    }
    await nextTick()
    // If an in-progress operation already exists for this ID, just show it.
    const existing = progressStore.operations.get(showOpts.installationId)
    if (existing && !existing.finished) {
      progressRef.value?.showOperation(showOpts.installationId)
      return
    }
    progressRef.value?.startOperation({
      installationId: showOpts.installationId,
      title: showOpts.title,
      apiCall: showOpts.apiCall as () => Promise<ActionResult>,
      cancellable: showOpts.cancellable,
      returnTo: showOpts.returnTo,
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
   * Open one of the four flow modals as a Tier 3 takeover overlay.
   * The imperative `open()` reset on each *Modal ref runs after the
   * takeover mounts so form state always starts fresh.
   */
  async function openFlowTakeover(component: FlowComponent, entrypoint: string): Promise<void> {
    // Opt the install-flow wizards into the dedicated "Discard install
    // setup?" cancel-prompt copy. The wizards have no destructive op
    // in flight (the install kicks off after the wizard's final step,
    // routed through `handleShowProgress`), so the generic "Cancel
    // current operation?" copy is misleading. No `onCancel` is set —
    // there is no main-side rollback to fire, just a wizard to dismiss.
    const ok = await openOverlay({ kind: 'takeover', component, cancelCopyKey: 'discard-setup' })
    if (!ok) return
    emitTelemetryAction('desktop2.install.flow.opened', {
      flow: FLOW_TELEMETRY_NAMES[component],
      entrypoint,
    })
    // Wait for the v-if branch in the takeover slot to mount the
    // component before reaching for its ref.
    await nextTick()
    if (component === 'new-install') {
      // Surface a Back link in the Configure footer when the chain
      // arrived via Local → Start Fresh. Read-and-clear so a subsequent
      // dashboard-initiated open() doesn't inherit the flag.
      const cameFromLocalBranch = opts.firstUseChain
        ? opts.firstUseChain.consumeCameFromLocalBranch() === true
        : false
      await newInstallRef.value?.open(
        cameFromLocalBranch ? { cameFromLocalBranch } : undefined,
      )
    }
    else if (component === 'track') trackRef.value?.open()
    else if (component === 'load-snapshot') loadSnapshotRef.value?.open()
    else if (component === 'quick-install') await quickInstallRef.value?.open()
  }

  /**
   * Open the first-use takeover. Auto-mounted from `onMounted` when
   * `launcherPrefs.firstUseCompleted` is false; not routed through
   * `switchPanel` because there's no URL/IPC entry point for it (the
   * gate is purely the persisted pref).
   *
   * Fetches the categorised first-use state from main so the takeover
   * can suppress the cloud-vs-local pick step for returning users. The
   * fetch runs in parallel with the overlay mount.
   */
  async function openFirstUseTakeover(
    firstUseOpts?: { initialStep?: 'consent' | 'pick' | 'localBranch' },
  ): Promise<void> {
    const statePromise = window.api
      .getFirstUseState()
      .catch(() => ({ skipPick: false, hasLegacyDesktop: false }))
    // Opt into the "Quit setup?" cancel-prompt copy so the OS-X
    // consult reads as a binding-flow exit dialog rather than the
    // generic `overlay.cancelCurrentTitle`.
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
      ...(firstUseOpts?.initialStep ? { initialStep: firstUseOpts.initialStep } : {}),
    })
  }

  /**
   * Bypass the takeover→null cancel-prompt for renderer-internal
   * intentional close paths (✕ on a takeover, post-completion auto-
   * close). The prompt belongs to the consult-from-main
   * `onCloseRequest` path; firing it on a user's own ✕ click would
   * be a redundant double-confirm.
   */
  function dismissTakeoverDirect(): void {
    // Whenever a Tier 3 overlay is cleared from the renderer side,
    // the host's first-use mode must drop back to `'none'`. Covers
    // both explicit completion paths (Cloud / chain-local close) AND
    // pure-dismiss paths (Track / LoadSnapshot / QuickInstall /
    // Manage / Progress ✕). FirstUseTakeover.vue's own
    // watch(step, …, immediate) handles the consent → post-consent
    // transitions; the renderer-internal dismiss is the only path
    // that can take the host from a non-'none' mode to 'none'
    // without a step change inside the takeover.
    if (currentOverlay.value?.kind === 'takeover' && currentOverlay.value.component === 'first-use') {
      window.api.setFirstUseMode('none')
    }
    // Any overlay opened via `setActivePanel` in main (the unified
    // settings overlay, and the four flow takeovers fired from the
    // file menu) flipped `entry.activePanel` away from `'comfy'`.
    // Closing the overlay only clears the renderer-side slot —
    // without IPC'ing main back to `'comfy'` two things break:
    //   - For settings: the live comfy WebContentsView stays hidden
    //     and the user perceives the running instance as "shut down".
    //   - For flow takeovers: `entry.activePanel` is stuck on the
    //     wizard key, so re-picking the same item from the file menu
    //     hits `setActivePanel`'s same-panel early-return and the
    //     modal never reopens.
    const cur = currentOverlay.value
    const isFlowTakeover =
      cur?.kind === 'takeover' && (FLOW_PANELS as ReadonlySet<string>).has(cur.component)
    if (cur?.kind === 'settings' || isFlowTakeover) {
      window.api.closeCurrentPanel()
    }
    currentOverlay.value = null
  }

  /**
   * Switch the underlying panel body. Flow keys divert into the Tier 3
   * takeover overlay slot instead of swapping the body. The unified
   * `settings` key opens the Tier 1 SettingsModal at the default tab
   * for the host (ComfyUI Settings on install-backed, Global Settings
   * on install-less); deeper tab targets come through the
   * `panel-trigger-overlay` IPC and bypass `switchPanel`.
   */
  async function switchPanel(panel: PanelKey, entrypoint: string = 'titlebar'): Promise<void> {
    const fromView = activePanel.value
    if (FLOW_PANELS.has(panel)) {
      await openFlowTakeover(panel as FlowComponent, entrypoint)
      return
    }
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
    // No-op guard so a redundant `panel-switch` IPC (e.g. main re-
    // confirms `'comfy-lifecycle'` after an instance stop while we're
    // already there) doesn't generate a noise event.
    if (panel === fromView) return
    activePanel.value = panel
    emitTelemetryAction('desktop2.view.opened', { view: panel, from_view: fromView })
  }

  return {
    activePanel,
    initialPanel,
    defaultBodyPanel,
    currentOverlay,
    openOverlay,
    closeOverlay,
    handleShowProgress,
    handleProgressClose,
    openFlowTakeover,
    openFirstUseTakeover,
    dismissTakeoverDirect,
    switchPanel,
  }
}
