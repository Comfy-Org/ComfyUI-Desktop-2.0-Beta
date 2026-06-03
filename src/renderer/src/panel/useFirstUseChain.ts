import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import { useInstallationStore } from '../stores/installationStore'
import { useProgressStore } from '../stores/progressStore'
import { useLauncherPrefs } from '../composables/useLauncherPrefs'
import { useMigrateAction } from '../composables/useMigrateAction'
import { useOverlay } from '../composables/useOverlay'
import { emitTelemetryAction } from '../lib/telemetry'
import type { FieldOption, Installation, ShowProgressOpts, Source } from '../types/ipc'
import type { ChooserLaunchOutcome } from './useChooserHandoff'
import type { FirstUseChainHooks, PanelKey } from './usePanelOverlays'

export interface FirstUseChainOpts {
  /** Routes the migrate-to-standalone op through the shared overlay
   *  pipeline (Tier 2 progress modal) and lets `usePanelOverlays`
   *  capture the auto-launch id via the `firstUseChain.onShowProgress`
   *  hook. */
  handleShowProgress: (opts: ShowProgressOpts) => Promise<void>
  /** Used by chain-local to mount the new-install Tier 3 takeover. */
  switchPanel: (panel: PanelKey, entrypoint?: string) => Promise<void>
  /** Direct-mutation overlay clear (no cancel-prompt) used by every
   *  completion path. */
  dismissTakeoverDirect: () => void
  /** Cloud-branch auto-launch and the post-install auto-launch
   *  watcher both reuse the chooser's launch pipeline. */
  performChooserLaunch: (
    installation: Installation,
    onMissingLaunchAction?: () => void
  ) => Promise<ChooserLaunchOutcome>
  /** Re-opens the FirstUseTakeover from the Configure → Back chain.
   *  Owned by usePanelOverlays. Pass `{ initialStep: 'localBranch' }`
   *  so the user lands on the sub-step they came from. */
  openFirstUseTakeover: (opts?: { initialStep?: 'start' | 'localBranch' }) => Promise<void>
}

export interface FirstUseChainApi {
  /** Hooks the parent passes back into
   *  `usePanelOverlays({ firstUseChain: … })`. */
  hooks: FirstUseChainHooks
  /** Bound on `<InstallWizardModal :hide-back-to-dashboard>` so the
   *  back-to-dashboard button hides during a chain. */
  chainingFirstUseToNewInstall: Ref<boolean>
  /** FirstUseTakeover `complete-skip` emit + file-menu Skip Onboarding. */
  completeFirstUseAndDismiss: () => Promise<void>
  /** FirstUseTakeover `complete-cloud` emit. */
  handleFirstUseComplete: () => Promise<void>
  /** FirstUseTakeover `chain-local` emit. Optional payload flags
   *  whether the chain reached us via the Local → Start Fresh
   *  sub-step (vs the direct no-legacy path), and whether the user
   *  asked for an Express install (skip the Configure screen and run
   *  Standalone + recommended defaults straight through to the
   *  install-progress takeover). */
  handleFirstUseChainLocal: (payload?: {
    cameFromLocalBranch?: boolean
    express?: boolean
  }) => Promise<void>
  /** FirstUseTakeover `chain-migrate` emit. */
  handleFirstUseChainMigrate: () => Promise<void>
  /** InstallWizardModal `close` / `navigate-list` emit when mounted as a
   *  takeover. */
  handleNewInstallTakeoverClose: () => Promise<void>
  /** InstallWizardModal `back-to-local-branch` emit. Silent Tier 3 → Tier 3
   *  swap back to the FirstUseTakeover localBranch step. */
  handleNewInstallBackToLocalBranch: () => Promise<void>
}

/**
 * Owns the first-use bootstrap chain — the consent → cloud-vs-local
 * fork that runs on the user's first launch. The chain has three
 * branches (Cloud auto-launch, Local → new-install takeover, Migrate
 * → migrate-to-standalone op) plus a Skip Onboarding entry from the
 * file menu, all of which converge on the same `markFirstUseCompleted`
 * → dismiss → `setFirstUseMode('none')` triple.
 *
 * Also owns the auto-launch watcher that fires once a chained
 * new-install or migration op finishes successfully — the user lands
 * on a running ComfyUI as the natural endpoint of bootstrap without
 * having to click play again.
 *
 * Dependencies on `usePanelOverlays` (showProgress, switchPanel,
 * dismissTakeoverDirect, currentOverlay) and `useChooserHandoff`
 * (performChooserLaunch) are passed in via opts. The `hooks` exit
 * point is wired back into `usePanelOverlays.firstUseChain` from the
 * parent; usePanelOverlays reads `shouldForceTakeover` to keep opaque
 * takeover chrome up across the install op, and calls `onShowProgress`
 * to capture the resulting install's id for the auto-launch watcher.
 */
export function useFirstUseChain(opts: FirstUseChainOpts): FirstUseChainApi {
  const installationStore = useInstallationStore()
  const progressStore = useProgressStore()
  const launcherPrefs = useLauncherPrefs()
  // First-use is the sole takeover-surface caller; pinning the surface
  // at the composable scope keeps the per-call API uniform across
  // MigrationBanner / DetailModal / useComfyUISettings.
  const { confirmMigration } = useMigrateAction({ surface: 'takeover' })
  // Module singleton — same slot the overlay composable owns.
  const { current: currentOverlay } = useOverlay()

  /** Set when the first-use takeover's Local branch chains into the
   *  new-install Tier 3 takeover. The new-install modal emits `close`
   *  after a successful install (the same hook used everywhere); when
   *  that fires while this flag is true the host marks
   *  `firstUseCompleted` and clears the flag. A Cloud-branch pick
   *  marks completion immediately and never sets this flag, so the
   *  two paths can't double-fire the pref write. */
  const chainingFirstUseToNewInstall = ref(false)

  /** Installation id of the Standalone install that the first-use
   *  chain (new-install or migration) just kicked off. Captured from
   *  the corresponding `show-progress` while the chain flag is set.
   *  The auto-launch watcher below launches the install once its op
   *  finishes successfully. */
  const pendingFirstUseAutoLaunchId = ref<string | null>(null)

  /** Installation id of an install op that opted in to auto-launch via
   *  `showOpts.autoLaunchOnFinish` (chooser tile, instance picker, File
   *  menu — every non-first-use install entry). The same watcher below
   *  fires `performChooserLaunch` when this id's op finishes, giving
   *  every install entry point the continuous install → security scan
   *  → starting server brand-loader experience first-use already has. */
  const pendingAutoLaunchId = ref<string | null>(null)

  /** Set by `handleFirstUseChainLocal` when the chain arrives via
   *  Local → Start Fresh. Read + cleared by usePanelOverlays via the
   *  `consumeCameFromLocalBranch` hook so InstallWizardModal opens with a
   *  Back link in its Configure footer. */
  const pendingCameFromLocalBranch = ref(false)

  /** One-shot flag raised in the auto-launch watcher just before the
   *  chained `performChooserLaunch` call. The launch action runs with
   *  `showProgress: true`, so the resulting `show-progress` comes back
   *  through `onShowProgress`; reading + clearing this flag there is
   *  what stamps the launch op as the second leg of the chain. */
  const pendingChainedLaunch = ref(false)

  const hooks: FirstUseChainHooks = {
    shouldForceTakeover: () => chainingFirstUseToNewInstall.value,
    consumeCameFromLocalBranch: () => {
      const v = pendingCameFromLocalBranch.value
      pendingCameFromLocalBranch.value = false
      return v
    },
    onShowProgress: (showOpts) => {
      // Capture the operation's installation id when a first-use chain
      // is in flight (new-install or migrate). New-install ops carry
      // the new install's id directly; migrate ops carry the Legacy
      // Desktop install's id and the watcher resolves the resulting
      // Standalone install from the store after the op finishes. Only
      // the first chained op captures the id — subsequent show-progress
      // calls leave it untouched.
      if (chainingFirstUseToNewInstall.value && pendingFirstUseAutoLaunchId.value === null) {
        pendingFirstUseAutoLaunchId.value = showOpts.installationId
        // Stamp the install op as the first leg of a chain so ProgressModal
        // maps its 0→100% to the unified bar's 0→70% slot.
        showOpts.chainSpan = 'install'
        // Flip the persisted gate now so the takeover doesn't re-run
        // on the next launch — the overlay handoff doesn't go through
        // InstallWizardModal's close emit.
        void launcherPrefs.markFirstUseCompleted()
        return
      }
      // Non-first-use install entry points (chooser tile, instance
      // picker, File menu) opt into the same auto-launch via the
      // `autoLaunchOnFinish` flag. The watcher below fires the launch
      // once the op finishes. No `markFirstUseCompleted` here — that's
      // first-use-only.
      if (showOpts.autoLaunchOnFinish === true && pendingAutoLaunchId.value === null) {
        pendingAutoLaunchId.value = showOpts.installationId
        showOpts.chainSpan = 'install'
        return
      }
      // Launch leg of the install→launch chain. The watcher set
      // `pendingChainedLaunch` just before kicking the launch action;
      // consume it here so ProgressModal maps this op to the unified
      // bar's 70→100% slot.
      if (pendingChainedLaunch.value) {
        pendingChainedLaunch.value = false
        showOpts.chainSpan = 'launch'
      }
    }
  }

  /** Shared completion helper. The Cloud-branch pick
   *  (`handleFirstUseComplete`), the file-menu Skip Onboarding entry,
   *  and the new-install chain close (`handleNewInstallTakeoverClose`)
   *  all run the same `markFirstUseCompleted` → dismiss sequence;
   *  extracting the pair keeps them in sync if the gate flip ever
   *  needs extra state cleanup. */
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
    opts.dismissTakeoverDirect()
  }

  /** First-use takeover Cloud-branch pick (`complete-cloud` emit).
   *  Mark completion, close the takeover, and auto-launch the always-
   *  present Cloud install so the user reaches a running ComfyUI as
   *  the natural endpoint of first-use without having to click play
   *  again. The launch goes through the same `useListAction` pipeline
   *  the chooser uses. If the cloud install can't be found we still
   *  mark complete and close the takeover — the chooser body
   *  underneath is the fallback.
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
      // the takeover so the user lands on the chooser body. The happy
      // path leaves the takeover up; the launch action's `showProgress:
      // true` swaps it for a connect-progress takeover (Tier 3 → Tier 3).
      const outcome = await opts.performChooserLaunch(cloud, opts.dismissTakeoverDirect)
      // `'launched'` swaps the takeover for the connect-progress
      // takeover automatically; `'missing-action'` already ran the
      // dismiss callback. `'focused-running'` short-circuits launch and
      // never opens a replacement — we have to dismiss here so the
      // first-use takeover doesn't sit stranded over the existing
      // running window.
      if (outcome === 'focused-running') {
        opts.dismissTakeoverDirect()
      }
      return
    }
    // No cloud install to launch into — fall back to dismissing the
    // takeover so the user lands on the chooser body underneath.
    opts.dismissTakeoverDirect()
  }

  /** First-use takeover Local-branch pick — chain into the new-install
   *  Tier 3 takeover. The Tier 3 → Tier 3 swap is silent in
   *  `useOverlay`, so the first-use takeover unmounts as the new-install
   *  takeover mounts. The completion flip is deferred to the new-install
   *  close path (see `handleNewInstallTakeoverClose`).
   *
   *  When `payload.express === true`, skip the Configure screen entirely
   *  and run the same `buildInstallation → addInstallation → show-progress`
   *  sequence Configure's `handleSave` runs, using the recommended option
   *  for every non-text field on the Standalone source (the same defaults
   *  Configure pre-selects). If any step fails, fall back to opening
   *  Configure so the user sees the actual error rather than a silent
   *  dead end. */
  async function handleFirstUseChainLocal(payload?: {
    cameFromLocalBranch?: boolean
    express?: boolean
  }): Promise<void> {
    chainingFirstUseToNewInstall.value = true
    pendingFirstUseAutoLaunchId.value = null
    pendingCameFromLocalBranch.value = payload?.cameFromLocalBranch === true

    if (payload?.express === true) {
      const expressOk = await runExpressInstall()
      if (expressOk) return
      // Fall through to the Configure screen — runExpressInstall already
      // reset chain bookkeeping on failure.
      chainingFirstUseToNewInstall.value = true
      pendingFirstUseAutoLaunchId.value = null
    }

    await opts.switchPanel('new-install', 'first_use')
    // FirstUseTakeover.onUnmounted just pushed `'none'` as the chain
    // swap unmounted it. Re-assert `'post-consent'` so the file-menu
    // builder keeps the chain locked down to Skip Onboarding while
    // the new-install / install-progress takeover is up.
    window.api.setFirstUseMode('post-consent')
  }

  /** Express install — the "skip Configure" path. Runs the Standalone
   *  source with the `recommended` option for every non-text field
   *  (mirroring Configure's `loadFieldOptions` default-selection logic),
   *  then hands off to the install-progress takeover via
   *  `handleShowProgress`. Returns `true` on success so the caller
   *  knows the chain handoff is complete; `false` if any precondition
   *  failed and the caller should fall back to opening Configure. */
  async function runExpressInstall(): Promise<boolean> {
    // Express vs Configure is the key onboarding-funnel split: express
    // skips the Configure screen and installs with recommended defaults.
    // The standalone install pipeline still fires its own
    // install.standalone.* funnel events; `express.started` marks WHICH
    // path the user took, and `express.fallback {reason}` records when
    // express bailed to Configure (so the funnel can separate
    // "express succeeded" from "express attempted but fell back").
    emitTelemetryAction('comfy.desktop.install.express.started', {})
    try {
      const hardware = await window.api.validateHardware()
      if (!hardware.supported) {
        console.warn('[firstUseChain] express: hardware unsupported', hardware)
        emitTelemetryAction('comfy.desktop.install.express.fallback', {
          reason: 'unsupported_hardware'
        })
        return false
      }

      const [installDir, sources] = await Promise.all([
        window.api.getDefaultInstallDir().catch(() => ''),
        window.api.getSources()
      ])
      const standalone = sources.find((s: Source) => s.id === 'standalone')
      if (!standalone) {
        console.warn('[firstUseChain] express: standalone source missing', { sources })
        emitTelemetryAction('comfy.desktop.install.express.fallback', {
          reason: 'precondition_failed'
        })
        return false
      }

      const selections: Record<string, FieldOption> = {}
      for (const field of standalone.fields) {
        if (field.type === 'text') {
          if (field.defaultValue !== undefined) {
            selections[field.id] = { value: field.defaultValue, label: field.defaultValue }
          }
          continue
        }
        const options = await window.api.getFieldOptions(
          standalone.id,
          field.id,
          selections,
          field.id === 'release' ? { includeLatestStable: true } : undefined
        )
        if (!options || options.length === 0) {
          console.warn('[firstUseChain] express: no options for field', field.id)
          emitTelemetryAction('comfy.desktop.install.express.fallback', {
            reason: 'precondition_failed'
          })
          return false
        }
        const pick = options.find((o) => o.recommended) ?? options[0]
        if (!pick) {
          emitTelemetryAction('comfy.desktop.install.express.fallback', {
            reason: 'precondition_failed'
          })
          return false
        }
        selections[field.id] = pick
      }

      const instData = await window.api.buildInstallation(standalone.id, selections)
      const name = await window.api.getUniqueName('ComfyUI')
      const installPath = installDir ?? ''

      const result = await window.api.addInstallation({
        name,
        installPath,
        ...instData
      })
      if (!result.ok || !result.entry) {
        console.warn('[firstUseChain] express: addInstallation failed', result)
        emitTelemetryAction('comfy.desktop.install.express.fallback', {
          reason: 'precondition_failed'
        })
        return false
      }

      // `onShowProgress` captures `pendingFirstUseAutoLaunchId` from this
      // call because `chainingFirstUseToNewInstall` is already true — the
      // auto-launch watcher takes the install through to a running ComfyUI
      // window the same way the Configure handoff does.
      await opts.handleShowProgress({
        installationId: result.entry.id,
        title: `Installing — ${name}`,
        apiCall: () => window.api.installInstance(result.entry!.id),
        autoLaunchOnFinish: true,
        opKind: 'install'
      })
      // `handleShowProgress` swaps the first-use takeover for the
      // install-progress takeover. Push `'post-consent'` so the file-menu
      // builder stays locked down for the duration of the install.
      window.api.setFirstUseMode('post-consent')
      return true
    } catch (err) {
      console.warn('[firstUseChain] express install failed; falling back to Configure', err)
      emitTelemetryAction('comfy.desktop.install.express.fallback', { reason: 'error' })
      chainingFirstUseToNewInstall.value = false
      pendingFirstUseAutoLaunchId.value = null
      return false
    }
  }

  /** InstallWizardModal `back-to-local-branch` emit. Silent Tier 3 → Tier 3
   *  swap that re-opens the FirstUseTakeover on its localBranch
   *  sub-step (the step the user came from). Drops chain bookkeeping so
   *  the close handler doesn't mistake the swap for first-use
   *  completion. */
  async function handleNewInstallBackToLocalBranch(): Promise<void> {
    chainingFirstUseToNewInstall.value = false
    pendingFirstUseAutoLaunchId.value = null
    pendingCameFromLocalBranch.value = false
    await opts.openFirstUseTakeover({ initialStep: 'localBranch' })
    // openFirstUseTakeover routes through openOverlay which pushes
    // `'consent-lockdown'` on mount; re-assert `'post-consent'` since
    // the user already passed consent earlier in this chain.
    window.api.setFirstUseMode('post-consent')
  }

  /** First-use takeover migrate-branch pick — runs migrate-to-standalone
   *  against the auto-tracked Legacy Desktop install. Same shape as
   *  the chain-local path: the migration progress op flows through
   *  `handleShowProgress` (Tier 2 progress modal), capturing
   *  `pendingFirstUseAutoLaunchId` for the resulting Standalone install
   *  along the way. The auto-launch watcher fires once the op finishes
   *  successfully. */
  async function handleFirstUseChainMigrate(): Promise<void> {
    let legacy = installationStore.installations.find((i) => i.sourceId === 'desktop') ?? null
    if (!legacy) {
      try {
        const all = await window.api.getInstallations()
        legacy = all.find((i) => i.sourceId === 'desktop') ?? null
      } catch {}
    }
    if (!legacy) {
      // Detection drift — main flagged hasLegacyDesktop=true but the
      // install is gone now. Bail to chain-local so the user still
      // gets to the new-install Standalone path.
      void handleFirstUseChainLocal()
      return
    }
    // First-use chain renders the migrate confirm as a brand takeover
    // (registered by PanelApp via `registerMigrateTakeover` and pinned
    // at `useMigrateAction({ surface: 'takeover' })` above). `null`
    // return means user cancelled; leave the takeover mounted on the
    // localBranch step (no state change).
    const result = await confirmMigration(legacy)
    if (!result) return

    // Pre-mark the chain so the new install kicked off by migration
    // gets captured as the auto-launch target.
    chainingFirstUseToNewInstall.value = true
    pendingFirstUseAutoLaunchId.value = null
    // Dismiss the takeover before kicking off the migration so the
    // Tier 2 progress modal isn't blocked by the takeover overlay.
    opts.dismissTakeoverDirect()
    await opts.handleShowProgress({
      installationId: legacy.id,
      title: `Migrating — ${legacy.name}`,
      apiCall: () => window.api.runAction(legacy!.id, 'migrate-to-standalone', result),
      cancellable: true
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
   *  cases count as "the user got past the cloud-or-local pick". */
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
    // The happy-path install handoff in InstallWizardModal swaps the
    // overlay to a progress takeover via @show-progress without first
    // emitting `close`, but `@navigate-list` still routes here for the
    // skipInstall branch — and dismissing then would clear an unrelated
    // overlay if anything else has claimed the slot in between.
    if (
      currentOverlay.value?.kind === 'takeover' &&
      currentOverlay.value.component === 'new-install'
    ) {
      opts.dismissTakeoverDirect()
    }
  }

  // Auto-launch watcher — fires once a captured install / migration op
  // finishes successfully. Two paths feed it:
  //   1. First-use chain (`pendingFirstUseAutoLaunchId`) — set by the
  //      chain-local / chain-migrate flows. Also clears first-use
  //      bookkeeping (`setFirstUseMode('none')`).
  //   2. `autoLaunchOnFinish` opt-in (`pendingAutoLaunchId`) — set by
  //      every non-first-use install entry point so chooser-tile /
  //      picker / File-menu installs get the same continuous install →
  //      launch brand-loader experience.
  // Whichever id is captured first wins for that op; the other ref
  // stays null. The launch action that runs at the end carries
  // `triggersInstanceStart: true`, so `usePanelOverlays` swaps the
  // install Tier 3 takeover for the launch Tier 3 takeover silently —
  // one continuous brand-loader screen.
  const stopWatch = watch(
    () => {
      const id = pendingFirstUseAutoLaunchId.value ?? pendingAutoLaunchId.value
      if (!id) return null
      const op = progressStore.operations.get(id)
      return op && op.finished ? op : null
    },
    async (op) => {
      if (!op) return
      const fromFirstUse = chainingFirstUseToNewInstall.value
      const id = pendingFirstUseAutoLaunchId.value ?? pendingAutoLaunchId.value
      // Clear both refs and the first-use chain flag up-front so a
      // late-arriving op event can't double-fire the watcher.
      chainingFirstUseToNewInstall.value = false
      pendingFirstUseAutoLaunchId.value = null
      pendingAutoLaunchId.value = null
      if (fromFirstUse) {
        // Chain is done (success or failure) — drop the file-menu lock.
        // The launch path that follows (when the op succeeded) replaces
        // the install-progress takeover with its own connect-progress
        // takeover; either way the user is past onboarding now.
        window.api.setFirstUseMode('none')
      }
      if (!id) return
      if (op.cancelRequested || op.error || !op.result?.ok) return
      // The migrate-to-standalone op runs against the Legacy Desktop
      // install but produces a fresh Standalone install — wait for the
      // store to reflect the new install, then launch the most-recently-
      // created non-cloud, non-legacy local install (the migration's
      // result). For new-install ops, the captured id is the new install's
      // id directly so this branch resolves immediately.
      let inst = installationStore.installations.find((i) => i.id === id) ?? null
      if (!inst || inst.sourceId === 'desktop') {
        try {
          await installationStore.fetchInstallations()
        } catch {}
        inst =
          installationStore.installations.find(
            (i) => (i as unknown as { copiedFrom?: string }).copiedFrom === id
          ) ??
          installationStore.installations
            .filter((i) => i.sourceCategory === 'local')
            .sort(
              (a, b) =>
                Date.parse(String(b.createdAt ?? '')) - Date.parse(String(a.createdAt ?? ''))
            )[0] ??
          null
      }
      if (inst) {
        // Mark the upcoming `show-progress` as the launch leg of the
        // chain. `onShowProgress` consumes the flag and stamps the op.
        pendingChainedLaunch.value = true
        void opts.performChooserLaunch(inst).finally(() => {
          // Defensive: if the launch never reached `handleShowProgress`
          // (missing-action / focused-running outcomes) clear the flag
          // so it can't leak into an unrelated future op.
          pendingChainedLaunch.value = false
        })
      }
    },
    { deep: false }
  )

  // File-menu Skip Onboarding entry — main forwards the click here.
  // Run the same completion sequence the Cloud-branch pick uses.
  let unsubFirstUseSkip: (() => void) | null = null
  onMounted(() => {
    unsubFirstUseSkip = window.api.onFirstUseSkip(() => {
      void completeFirstUseAndDismiss()
    })
  })

  onUnmounted(() => {
    stopWatch()
    unsubFirstUseSkip?.()
  })

  return {
    hooks,
    chainingFirstUseToNewInstall,
    completeFirstUseAndDismiss,
    handleFirstUseComplete,
    handleFirstUseChainLocal,
    handleFirstUseChainMigrate,
    handleNewInstallTakeoverClose,
    handleNewInstallBackToLocalBranch
  }
}
