import {
  computed,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref
} from 'vue'
import { useI18n } from 'vue-i18n'
import { useModal } from './useModal'
import { useDialogs } from './useDialogs'
import { useActionGuard } from './useActionGuard'
import { useMigrateAction } from './useMigrateAction'
import { useSessionStore } from '../stores/sessionStore'
import { emitTelemetryAction, toErrorBucket } from '../lib/telemetry'
import { progressOpKindForActionId, destroysInstanceForActionId } from '../lib/progressOpKind'
import {
  REQUIRES_STOPPED,
  type ActionDef,
  type ActionResult,
  type DetailField,
  type DetailSection,
  type DiskSpaceInfo,
  type Installation,
  type ShowProgressOpts
} from '../types/ipc'
import { shareLatestSnapshot } from '../lib/snapshots'
import {
  IN_PLACE_RELAUNCH,
  augmentActionWithStopWarning,
  stopAndWaitForExit
} from '../lib/stopWarning'
import { sleepRemainder } from '../lib/uiTiming'
import type { SectionTab } from '../lib/pickerTabs'
import {
  runConfirmChain,
  runDiskSpaceCheck,
  runFieldSelectsChain,
  runPromptChain,
  runSelectChain
} from './actionShoppingList'

/**
 * Backing state + IPC plumbing for the brand-redesigned Settings drawer
 * (`ComfyUISettingsPanel.vue`). Extracted into a composable so the
 * component stays UI-only — same convention as the title-bar
 * `useTitleBarMenus` / `usePanelOverlays` split.
 *
 * All four tabs source from `getDetailSections()` — the same payload
 * `DetailModal` reads — and writes through `update-installation` /
 * `runAction`. Disk Usage is a separate `get-disk-space` call merged
 * into the Status tab as a synthetic row.
 *
 * Action handling mirrors `DetailModal.runAction` exactly:
 *   1. Busy-only guard via useActionGuard (in-progress op cancel-confirm)
 *   2. `migrate-to-standalone` special case → useMigrateAction
 *   3. willStopRunning augment for REQUIRES_STOPPED while running —
 *      prepends the stop-warning sentence to confirm / prompt messages
 *      so the user knows the running ComfyUI will be stopped to proceed
 *   4. fieldSelects chain → modal.select per fieldSelect
 *   5. select chain → modal.select (e.g. installations)
 *   6. prompt chain → modal.prompt
 *   7. confirm chain → modal.confirm or modal.confirmWithOptions
 *   8. disk-space check for copy / copy-update / release-update
 *   9. showProgress → opts.onShowProgress with self-stopping apiCall +
 *      in-place relaunch for update-comfyui / snapshot-restore
 *  10. inline → window.api.runAction (also self-stops when needed)
 */

export interface UseComfyUISettingsOpts {
  /** Accept any reactive source — `Ref`, `ComputedRef`, or getter — so
   *  callers can pass `toRef(props, 'installation')` directly. */
  installation: MaybeRefOrGetter<Installation | null>
  /** Fires when an action requests a ProgressModal — the host
   *  (`PanelApp.vue`) already owns the modal and consumes this shape
   *  via `usePanelOverlays.handleShowProgress`. */
  onShowProgress: (opts: ShowProgressOpts) => void
  /** Fired when an action's `result.navigate === 'list'` — the install
   *  was removed (delete / untrack). The drawer host should close the
   *  drawer and tear down the comfy window — mirrors DetailModal's
   *  `emit('navigate-list')`. */
  onNavigateList?: () => void
  /** Fired alongside `onNavigateList` so the drawer can animate its
   *  own dismissal before the host completes the navigation — mirrors
   *  DetailModal's `emit('close')`. */
  onClose?: () => void
}

export interface UseComfyUISettingsApi {
  sections: Ref<DetailSection[]>
  diskSpace: Ref<DiskSpaceInfo | null>
  loading: Ref<boolean>
  error: Ref<string | null>

  /** True when the currently-painted `sections` / `diskSpace` /
   *  `installSize` payload belongs to the currently-selected install.
   *  Lags briefly during a picker row switch — the previous install's
   *  payload stays painted until the new install's IPC resolves so
   *  the right pane doesn't flash "Loading…" (#782). Hosts gate
   *  per-install action invocations on this (footer More menu, body
   *  pointer-events) so a click during the stale window can't run
   *  an action defined by the previous install's payload. */
  sectionsFresh: ComputedRef<boolean>

  /** Transient, non-blocking status line (e.g. a manual "Check for
   *  update" that found nothing). Set with an auto-clear timer; the host
   *  renders it inline and fades it out rather than blocking on a modal. */
  notice: Ref<string | null>

  /** Refresh sections + disk usage for the current installation. */
  reload: () => Promise<void>

  /** Per-section refresh (parity with legacy DetailModal). Splices
   *  only the named section in-place — leaves the other sections'
   *  Vue subtrees intact, so collapse state and internal scrolls
   *  survive the refresh. Falls back to full `reload()` when the
   *  title is missing or no longer in the new payload. */
  refreshSection: (sectionTitle: string | undefined) => Promise<void>

  /** Push a single field mutation through `update-installation` and
   *  reload sections so the UI tracks main-side defaults / clamping. */
  updateField: (field: DetailField, value: unknown) => Promise<void>

  /** Field ids edited while the install is running that carry
   *  `requiresRestart` AND whose current value differs from the
   *  value the running process was launched with. Drives the
   *  per-field "Restart to apply" pill and the footer button's
   *  yellow promotion. State is held per-install internally so
   *  switching the picker selection doesn't drop the marker. */
  pendingRestartFieldIds: ComputedRef<Set<string>>

  /** Transient error messages for the currently-selected install,
   *  keyed by field id. Populated when `updateField`'s IPC rejects
   *  or times out — the field's display is rolled back and a red
   *  inline pill surfaces the message. Auto-clears after a short
   *  timer or on the next edit of the same field. */
  fieldErrorMessages: ComputedRef<Map<string, string>>

  /** Commit a new display name for the selected install (inline hero
   *  edit). Resolves `true` when committed, `false` on no-op / rejection
   *  (duplicate name → alert). */
  renameInstallation: (newName: string) => Promise<boolean>

  /** Run an action coming off a `DetailSection.actions[]` entry. */
  runAction: (action: ActionDef) => Promise<void>

  /** Action ids currently in-flight on the inline path (no
   *  `showProgress` — those route to ProgressModal instead). Drives the
   *  per-button spinner + disabled state so clicks feel acknowledged. */
  runningActionIds: Ref<Set<string>>

  /** Visible sections for a given tab (filtered by `section.tab`). */
  sectionsForTab: (tab: SectionTab) => ComputedRef<DetailSection[]>

  /** Synthetic Status-tab row carrying the disk-usage reading. The
   *  status section payload doesn't include this — it lives on its own
   *  IPC — so the component renders it alongside the regular items. */
  diskUsageItem: ComputedRef<{ label: string; value: string } | null>

  /** Install-level actions (`pinBottom` section from main). */
  pinBottomSection: ComputedRef<DetailSection | null>

  /** `pinBottomSection.actions` with the renderer-side Launch→Restart
   *  swap applied — when the install is running, `'launch'` becomes
   *  `'restart'` (confirm + stop→launch chain). Mirrors DetailModal's
   *  `bottomActions` computed exactly. */
  pinBottomActions: ComputedRef<ActionDef[]>
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function useComfyUISettings(opts: UseComfyUISettingsOpts): UseComfyUISettingsApi {
  const { t } = useI18n()
  const modal = useModal()
  const dialogs = useDialogs()
  const actionGuard = useActionGuard()
  const { confirmMigration } = useMigrateAction()
  const sessionStore = useSessionStore()

  const sections = ref<DetailSection[]>([])
  const diskSpace = ref<DiskSpaceInfo | null>(null)
  /** Install's own on-disk footprint in bytes. Fetched via
   *  `getInstallationSize` which walks the directory tree, so it
   *  lands after the initial render and is `null` until then. Drives
   *  the Status tab's Disk Usage row — `total - free` would be the
   *  whole volume's used space, which is not what users want here. */
  const installSize = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  // Transient, non-blocking status line (e.g. a manual "Check for update"
  // that found nothing). Rendered inline by the host and auto-cleared, so
  // it never interrupts the user the way a modal alert would.
  const notice = ref<string | null>(null)
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  const NOTICE_TTL_MS = 4000
  function flashNotice(message: string): void {
    if (noticeTimer) clearTimeout(noticeTimer)
    notice.value = message
    noticeTimer = setTimeout(() => {
      notice.value = null
      noticeTimer = null
    }, NOTICE_TTL_MS)
  }
  // Inline-action busy state. Replaced (not mutated) on each add/delete
  // so Vue's shallow reactivity on Set tracks the change.
  const runningActionIds = ref<Set<string>>(new Set())
  // Restart-required dirty tracking — per install, keyed by field id,
  // value is the "running baseline" (the value the running process was
  // launched with). A field is dirty iff its current value differs
  // from this baseline; reverting to the baseline drops the entry.
  // Keyed by install id (not the picker's current selection) so
  // toggling the picker row doesn't lose state for the install the
  // user actually edited.
  const restartBaselines = ref<Map<string, Map<string, unknown>>>(new Map())
  // Transient error messages for failed `updateInstallation` IPCs.
  // Same per-install keying as restartBaselines so each install's
  // surface state is independent.
  const errorMessages = ref<Map<string, Map<string, string>>>(new Map())
  // 4-second auto-clear timers for inline error pills, keyed by
  // `installId:fieldId`. Cleared on re-edit or on watcher teardown.
  const errorClearTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Optimistic-update timeout: roll back if main hasn't responded
  // within 5s. Settings writes are local IPC + a JSON merge — if
  // they take this long, something is genuinely wrong.
  const UPDATE_TIMEOUT_MS = 5000
  // Inline error pill auto-clear window. Long enough to read, short
  // enough not to nag.
  const ERROR_TAG_TTL_MS = 4000
  /** Last install id `loadAll` was called with — used by
   *  `refreshSection` to drop late same-install splices after a switch. */
  let lastLoadedId: string | null = null
  /** Install id whose payload currently sits in `sections` /
   *  `diskSpace` / `installSize`. Tracks "what's painted" rather
   *  than "what we asked for"; backs the public `sectionsFresh`
   *  computed below. */
  const sectionsPayloadId = ref<string | null>(null)
  /** Monotonically increasing request id. Each `loadAll` /
   *  `refreshSection` call captures the next value and only writes
   *  results back into the refs if it is still the latest in-flight
   *  request. Prevents A→B→A clicks from letting B's late response
   *  overwrite A's pane. */
  let requestSeq = 0

  async function loadAll(installationId: string, installPath: string): Promise<void> {
    // We deliberately do NOT blank `sections` / `diskSpace` /
    // `installSize` here on install switch. Blanking caused a visible
    // "Loading…" flash for the (very brief) IPC window on every row
    // click in the instance picker (#782). Keeping the previous
    // payload in place trades the flicker for a soft swap when the
    // new payload lands. The new install's identity is the prop
    // already; only the body has to await, and the crossfade on the
    // host (`ComfyUISettingsContent.vue`, keyed on install id) makes
    // the transition read as intentional. `sectionsInstallationId`
    // below still reflects the previous install until the new payload
    // resolves, so hosts can gate per-install action invocations on
    // freshness (the footer More menu does this).
    lastLoadedId = installationId
    loading.value = true
    error.value = null
    const seq = ++requestSeq
    try {
      const [secs, disk] = await Promise.all([
        window.api.getDetailSections(installationId),
        installPath ? window.api.getDiskSpace(installPath).catch(() => null) : Promise.resolve(null)
      ])
      if (seq !== requestSeq) return
      sections.value = secs
      diskSpace.value = disk
      sectionsPayloadId.value = installationId
    } catch (e) {
      if (seq !== requestSeq) return
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (seq === requestSeq) loading.value = false
    }
    // Install-footprint scan runs after the main load so it can't
    // block the initial render. Drops in once it lands.
    void window.api
      .getInstallationSize(installationId)
      .then((r) => {
        if (seq !== requestSeq) return
        installSize.value = typeof r?.sizeBytes === 'number' ? r.sizeBytes : null
      })
      .catch(() => {
        if (seq !== requestSeq) return
        installSize.value = null
      })
  }

  async function reload(): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) {
      sections.value = []
      diskSpace.value = null
      installSize.value = null
      sectionsPayloadId.value = null
      lastLoadedId = null
      // Bump the sequence so any in-flight loadAll for a previous
      // install can't write into our now-cleared refs.
      requestSeq++
      return
    }
    await loadAll(inst.id, inst.installPath ?? '')
  }

  /** Per-section refresh (parity with legacy DetailModal). Fetches
   *  the full sections payload but only splices the matching title
   *  in-place — leaves the other sections' Vue subtrees intact, which
   *  preserves things like collapse state and any internal scroll. */
  async function refreshSection(sectionTitle: string | undefined): Promise<void> {
    if (!sectionTitle) {
      await reload()
      return
    }
    const inst = toValue(opts.installation)
    if (!inst) return
    const targetId = inst.id
    const seq = ++requestSeq
    try {
      const fresh = await window.api.getDetailSections(targetId)
      // Drop the result if the install changed or a newer request
      // beat us in flight — prevents A→B→A from letting B's late
      // response splice into A's pane.
      if (seq !== requestSeq || lastLoadedId !== targetId) return
      const updated = fresh.find((s) => s.title === sectionTitle)
      if (!updated) {
        // Title disappeared from the new payload — main mutated the
        // section list, so fall back to a full replace to stay coherent.
        sections.value = fresh
        return
      }
      const idx = sections.value.findIndex((s) => s.title === sectionTitle)
      if (idx >= 0) {
        sections.value.splice(idx, 1, updated)
      } else {
        sections.value = fresh
      }
    } catch (e) {
      if (seq !== requestSeq) return
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  /** Field-value equality for the restart-required set. Primitives
   *  compare by `===`; `envVars` is a flat `Record<string, string>` so
   *  a key-count + key-by-key walk is enough (no nested objects exist
   *  in the schema today). Falls back to JSON for any other object
   *  shape that might appear later. */
  function restartFieldsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a == null || b == null) return false
    if (typeof a !== 'object' || typeof b !== 'object') return false
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const aKeys = Object.keys(ao)
    const bKeys = Object.keys(bo)
    if (aKeys.length !== bKeys.length) return false
    for (const k of aKeys) {
      if (ao[k] !== bo[k]) return false
    }
    return true
  }

  /** Race a promise against a wall-clock deadline. Resolves with the
   *  promise's value on success; throws an Error tagged with
   *  `isTimeout = true` on deadline. The losing branch's eventual
   *  settlement is ignored — callers have already rolled back. */
  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('timeout') as Error & { isTimeout?: boolean }
        err.isTimeout = true
        reject(err)
      }, ms)
    })
    return Promise.race([p, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  /** Locate a field by id inside the current sections, mutating
   *  helpers operate via this. Returns the field reference so callers
   *  can write `field.value` in place — Vue's deep reactivity picks
   *  up the nested write because `sections` is a `ref` over an array
   *  of plain objects. */
  function findFieldInSections(fieldId: string): DetailField | null {
    for (const s of sections.value) {
      const f = s.fields?.find((x) => x.id === fieldId)
      if (f) return f as DetailField
    }
    return null
  }

  function setRestartDirty(installId: string, fieldId: string, baseline: unknown): void {
    const next = new Map(restartBaselines.value)
    const inner = new Map(next.get(installId) ?? new Map())
    if (!inner.has(fieldId)) inner.set(fieldId, baseline)
    next.set(installId, inner)
    restartBaselines.value = next
  }

  function clearRestartDirty(installId: string, fieldId: string): void {
    const inner = restartBaselines.value.get(installId)
    if (!inner || !inner.has(fieldId)) return
    const next = new Map(restartBaselines.value)
    const nextInner = new Map(inner)
    nextInner.delete(fieldId)
    if (nextInner.size === 0) next.delete(installId)
    else next.set(installId, nextInner)
    restartBaselines.value = next
  }

  function setFieldError(installId: string, fieldId: string, message: string): void {
    const next = new Map(errorMessages.value)
    const inner = new Map(next.get(installId) ?? new Map())
    inner.set(fieldId, message)
    next.set(installId, inner)
    errorMessages.value = next
    const timerKey = `${installId}:${fieldId}`
    const existing = errorClearTimers.get(timerKey)
    if (existing) clearTimeout(existing)
    errorClearTimers.set(
      timerKey,
      setTimeout(() => {
        clearFieldError(installId, fieldId)
      }, ERROR_TAG_TTL_MS)
    )
  }

  function clearFieldError(installId: string, fieldId: string): void {
    const timerKey = `${installId}:${fieldId}`
    const existing = errorClearTimers.get(timerKey)
    if (existing) {
      clearTimeout(existing)
      errorClearTimers.delete(timerKey)
    }
    const inner = errorMessages.value.get(installId)
    if (!inner || !inner.has(fieldId)) return
    const next = new Map(errorMessages.value)
    const nextInner = new Map(inner)
    nextInner.delete(fieldId)
    if (nextInner.size === 0) next.delete(installId)
    else next.set(installId, nextInner)
    errorMessages.value = next
  }

  async function updateField(field: DetailField, value: unknown): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) return
    const installId = inst.id

    // Capture the value the running process currently has — this is
    // both the baseline for dirty-tracking and the rollback target.
    const liveField = findFieldInSections(field.id)
    const priorValue = liveField ? liveField.value : (field.value as unknown)
    // Optimistic write — splice the new value into sections in place
    // so the dropdown / toggle re-renders on the same frame as the
    // click. `reload()` or `refreshSection()` below reconciles with
    // any main-side normalization.
    if (liveField) liveField.value = value as DetailField['value']

    // Re-edit clears any prior error pill for this field — the user
    // moved on, the stale message would be noise.
    clearFieldError(installId, field.id)

    try {
      await withTimeout(
        window.api.updateInstallation(installId, { [field.id]: value }),
        UPDATE_TIMEOUT_MS
      )
    } catch (err: unknown) {
      // Roll back the optimistic write.
      const live = findFieldInSections(field.id)
      if (live) live.value = priorValue as DetailField['value']
      // Failed writes never engage the restart-required state — main
      // didn't accept the value, so there's nothing to apply.
      clearRestartDirty(installId, field.id)
      const isTimeout = (err as { isTimeout?: boolean })?.isTimeout === true
      const message = isTimeout
        ? t('comfyUISettings.updateFieldTimeout', "Couldn't reach app — try again")
        : err instanceof Error
          ? err.message
          : String(err)
      setFieldError(installId, field.id, message)
      return
    }
    // Restart-required dirty tracking — only after the IPC succeeded.
    // Reverting to the running baseline drops the entry.
    if (field.requiresRestart && sessionStore.isRunning(installId)) {
      const baseline = restartBaselines.value.get(installId)?.get(field.id) ?? priorValue
      if (restartFieldsEqual(value, baseline)) {
        clearRestartDirty(installId, field.id)
      } else {
        setRestartDirty(installId, field.id, baseline)
      }
    }
    emitTelemetryAction('comfy.desktop.settings.changed', {
      setting_key: field.id,
      value_kind: field.editType || 'text',
      bool_value: typeof value === 'boolean' ? value : undefined
    })
    // Parity with legacy DetailSection: a field can declare an
    // `onChangeAction` to fire automatically after its value changes
    // (e.g. switching update channel triggers `check-update` so the
    // preview metadata refreshes without an extra click). Surface
    // failures via modal so the user can react.
    if (field.onChangeAction) {
      try {
        await window.api.runAction(inst.id, field.onChangeAction)
      } catch (err: unknown) {
        await dialogs.alert({
          title: t('common.error', 'Error'),
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }
    // When a field opts into `refreshSection`, splice only that
    // section instead of replacing the whole array — preserves Vue
    // subtrees and collapse state for sections the user wasn't
    // touching.
    if (field.refreshSection) {
      const owningSection = sections.value.find((s) => s.fields?.some((f) => f.id === field.id))
      await refreshSection(owningSection?.title)
    } else {
      await reload()
    }
  }

  /** Commit a new display name for the selected install. Shared by the
   *  About-tab inline hero edit; the footer "More → Rename" path runs
   *  through `runAction` instead, but both reconcile via
   *  `update-installation` → `'changed'` → store refetch. The IPC handler
   *  owns the duplicate-name guard — a rejection surfaces here as an alert
   *  and the `installation` prop stays put.
   *
   *  Resolves `true` when the name was committed, `false` on a no-op
   *  (empty / unchanged) or a rejection (duplicate). The hero uses this to
   *  revert its optimistic text only when the write didn't land. */
  async function renameInstallation(newName: string): Promise<boolean> {
    const inst = toValue(opts.installation)
    if (!inst) return false
    const name = newName.trim()
    if (!name || name === inst.name) return false
    const result: ActionResult | void = await window.api.updateInstallation(inst.id, { name })
    if (result?.ok === false) {
      await dialogs.alert({ title: inst.name, message: result.message ?? '' })
      return false
    }
    await reload()
    return true
  }

  async function runAction(action: ActionDef): Promise<void> {
    const inst = toValue(opts.installation)
    if (!inst) return

    // Share — export the latest snapshot via the OS save dialog. It's a
    // renderer-side IPC (export + native dialog), not a source action, so
    // intercept it before the source-action dispatch chain below. A cancel
    // is a silent no-op; only the genuine failures get an alert.
    if (action.id === 'share') {
      const result = await shareLatestSnapshot(inst.id)
      if (!result.ok) {
        await dialogs.alert({
          title: action.label,
          message:
            result.reason === 'none'
              ? t('snapshots.noSnapshotsToShare', 'There are no snapshots to share yet.')
              : (result.message ?? t('snapshots.shareFailed', 'Could not share the snapshot.'))
        })
      }
      return
    }

    const telemetryContext = { action_id: action.id }

    // 1. Busy-only guard. migrate-to-standalone manages its own busy
    //    check + UI via useMigrateAction below, so skip both this
    //    pre-flight and the step-3 message augment for it. The apiCall
    //    self-stop still applies — migrate is REQUIRES_STOPPED and the
    //    source session must be torn down before the backend handler
    //    runs.
    const ownsPreflight = action.id === 'migrate-to-standalone'
    const requiresStoppedGuard = REQUIRES_STOPPED.has(action.id)
    const wasRunning = sessionStore.isRunning(inst.id)
    if (requiresStoppedGuard && !ownsPreflight) {
      const proceed = await actionGuard.checkBeforeAction(inst.id, action.label)
      if (!proceed) return
    }

    let mutableAction: ActionDef = { ...action }

    // 2. migrate-to-standalone — dedicated brand takeover registered by
    //    PanelApp via `registerMigrateTakeover`. Returns the form data
    //    (checkbox values, etc.) which we merge into the action data.
    if (mutableAction.id === 'migrate-to-standalone') {
      const migrateResult = await confirmMigration(inst, mutableAction.confirm)
      if (!migrateResult) return
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, ...migrateResult }
      }
    }

    // 3. Stop-warning augment. No per-action confirm/prompt copy
    //    mentions the stop today, and the standalone stop-confirm modal
    //    was removed, so prepend the sentence to whatever the action
    //    already says (or use it standalone if the action has neither).
    //    Skipped for migrate-to-standalone — useMigrateAction handles
    //    its own confirm surface (modal OR brand takeover).
    if (requiresStoppedGuard && wasRunning && !ownsPreflight) {
      mutableAction = augmentActionWithStopWarning(
        mutableAction,
        t('errors.willStopRunning', { name: inst?.name || 'ComfyUI' })
      )
    }

    // 4-8. Shopping-list chain steps — fieldSelects → select → prompt
    //      → confirm → disk-check. Each helper drives a modal when the
    //      action carries the corresponding chain, returns the merged
    //      action on success, or null on cancel / failure. The confirm
    //      step skips migrate-to-standalone, which owns its confirm
    //      surface (modal OR brand takeover) up in step #2.
    //      fieldSelects / select / prompt route through `dialogs.*`
    //      (BaseModal-shell primitives); confirm + disk-check stay on
    //      `useModal` for `confirmWithOptions` parity.
    const afterFieldSelects = await runFieldSelectsChain(mutableAction, dialogs, t)
    if (!afterFieldSelects) return
    mutableAction = afterFieldSelects

    const afterSelect = await runSelectChain(mutableAction, inst.id, dialogs, t)
    if (!afterSelect) return
    mutableAction = afterSelect

    const afterPrompt = await runPromptChain(mutableAction, dialogs)
    if (!afterPrompt) return
    mutableAction = afterPrompt

    if (mutableAction.id !== 'migrate-to-standalone') {
      const afterConfirm = await runConfirmChain(mutableAction, modal, dialogs)
      if (!afterConfirm) return
      mutableAction = afterConfirm
    }

    if (!(await runDiskSpaceCheck(mutableAction, inst, modal, t, null, dialogs))) return

    // 9. showProgress — emit show-progress for the host's ProgressModal.
    //    The synthetic `restart` id maps to stop → wait → launch so the
    //    user sees one continuous "Restarting ComfyUI" progress view.
    //    REQUIRES_STOPPED ops against a running install wrap the
    //    apiCall to stop ComfyUI → wait → run the op, and append a
    //    relaunch when the action is in IN_PLACE_RELAUNCH.
    if (mutableAction.showProgress) {
      const rawTitle = (mutableAction.progressTitle || mutableAction.label).replace(
        /\{(\w+)\}/g,
        (_, k: string) => String((mutableAction.data as Record<string, unknown>)?.[k] ?? k)
      )
      const title = `${rawTitle} — ${inst.name}`
      const isRestart = mutableAction.id === 'restart'
      const needsSelfStop = wasRunning && requiresStoppedGuard && !isRestart
      const wantsRelaunch = needsSelfStop && IN_PLACE_RELAUNCH.has(mutableAction.id)
      const isRunning = (): boolean => sessionStore.isRunning(inst.id)
      const apiCall = isRestart
        ? async (): Promise<ReturnType<typeof window.api.runAction>> => {
            await stopAndWaitForExit(inst.id, isRunning)
            return window.api.runAction(inst.id, 'launch')
          }
        : needsSelfStop
          ? async (): Promise<ReturnType<typeof window.api.runAction>> => {
              await stopAndWaitForExit(inst.id, isRunning)
              const result = await window.api.runAction(
                inst.id,
                mutableAction.id,
                mutableAction.data
              )
              if (wantsRelaunch && result?.ok !== false) {
                await window.api.runAction(inst.id, 'launch')
              }
              return result
            }
          : (): ReturnType<typeof window.api.runAction> =>
              window.api.runAction(inst.id, mutableAction.id, mutableAction.data)
      emitTelemetryAction('comfy.desktop.action.invoked', telemetryContext)
      opts.onShowProgress({
        installationId: inst.id,
        title,
        apiCall,
        cancellable: !!mutableAction.cancellable,
        returnTo: 'detail',
        triggersInstanceStart: mutableAction.id === 'launch' || isRestart || wantsRelaunch,
        // Synthetic `restart` id (stop → wait → launch) reads as a launch
        // op to the brand caption pipeline, mirroring its
        // triggersInstanceStart flag.
        opKind: isRestart ? 'launch' : progressOpKindForActionId(mutableAction.id),
        destroysInstance: destroysInstanceForActionId(mutableAction.id),
        actionId: mutableAction.id,
        actionData: mutableAction.data
      })
      return
    }

    // 10. Inline invoke + result navigation. Self-stop wrap mirrors the
    //     showProgress path so inline REQUIRES_STOPPED actions don't
    //     race the backend's running-check on a running install.
    runningActionIds.value = new Set(runningActionIds.value).add(mutableAction.id)
    // Track when the spinner went up so we can floor its lifetime in
    // the finally. Sub-frame backend responses (rate-limit cache hits,
    // already-up-to-date short-circuits, dev-mode no-ops) would
    // otherwise hide the spinner inside one frame and the click would
    // read as a no-op. See `MIN_BUSY_FEEDBACK_MS` in `lib/uiTiming.ts`.
    const busyStartedAt = Date.now()
    try {
      emitTelemetryAction('comfy.desktop.action.invoked', telemetryContext)
      if (wasRunning && requiresStoppedGuard) {
        await stopAndWaitForExit(inst.id, () => sessionStore.isRunning(inst.id))
      }
      const result = await window.api.runAction(inst.id, mutableAction.id, mutableAction.data)
      if (result.running) {
        // Backend race — apiCall self-stop should have prevented this,
        // but if a launch slipped in between the stop and the action
        // invocation, surface the busy guard so the user can retry.
        await actionGuard.checkBeforeAction(inst.id, mutableAction.label)
        return
      }
      const resultValue = result.cancelled ? 'cancelled' : result.ok === false ? 'failed' : 'ok'
      emitTelemetryAction('comfy.desktop.action.result', {
        result: resultValue,
        ...telemetryContext
      })
      if (result.navigate === 'list') {
        opts.onClose?.()
        opts.onNavigateList?.()
      } else if (result.navigate === 'detail') {
        await reload()
        // An action can both reload the detail view AND carry a message
        // (e.g. a manual "Check for update" that found nothing — it
        // refreshes the "last checked" stamp and reports being up to
        // date). Surface it as a transient inline notice, not a modal:
        // it's confirmation of a no-op, not something to interrupt for.
        if (result.message) {
          flashNotice(result.message)
        }
      } else if (result.message) {
        await dialogs.alert({ title: mutableAction.label, message: result.message })
      } else {
        await reload()
      }
    } catch (err: unknown) {
      emitTelemetryAction('comfy.desktop.action.result', {
        result: 'failed',
        error_bucket: toErrorBucket(err),
        ...telemetryContext
      })
      await dialogs.alert({
        title: mutableAction.label,
        message: err instanceof Error ? err.message : String(err)
      })
    } finally {
      await sleepRemainder(busyStartedAt)
      const next = new Set(runningActionIds.value)
      next.delete(mutableAction.id)
      runningActionIds.value = next
    }
  }

  function sectionsForTab(tab: SectionTab): ComputedRef<DetailSection[]> {
    // `pinBottom` sections live in the drawer footer, not the tab body —
    // mirror DetailModal.vue's split (`mainSections` vs `bottomSection`).
    return computed(() => sections.value.filter((s) => s.tab === tab && !s.pinBottom))
  }

  const pinBottomSection = computed<DetailSection | null>(
    () => sections.value.find((s) => s.pinBottom) ?? null
  )

  // Launch→Restart synthetic swap, mirrored from DetailModal.vue's
  // `bottomActions`. Source action definitions stay single-purpose
  // (`launch`); `runAction` picks the synthetic `'restart'` id up and
  // routes through stopComfyUI → wait → launch.
  const pinBottomActions = computed<ActionDef[]>(() => {
    const acts = (pinBottomSection.value?.actions ?? []).filter(
      (a) => a.id !== 'launch' && a.id !== 'restart'
    )
    const inst = toValue(opts.installation)
    if (!inst) return acts
    return acts
  })

  const diskUsageItem = computed<{ label: string; value: string } | null>(() => {
    // Prefer the install's own footprint (`getInstallationSize` walks
    // the install directory). The whole-volume `total - free` calc the
    // old version used was the disk's used space, not the install's,
    // which made the row read as "free space" semantics on a near-full
    // drive.
    if (installSize.value !== null) {
      return {
        label: t('comfyUISettings.diskUsage', 'Disk Usage'),
        value: formatBytes(installSize.value)
      }
    }
    // While the directory scan is still in flight, fall back to a
    // "—" placeholder so the row is present (otherwise it pops in
    // mid-render). `diskSpace` being null also gets us here.
    if (!diskSpace.value) return null
    return {
      label: t('comfyUISettings.diskUsage', 'Disk Usage'),
      value: '—'
    }
  })

  // Pending restart fields surfaced to the host — derived from the
  // per-install baseline map for the currently-selected install. State
  // for OTHER installs stays in the map untouched, so toggling the
  // picker row never wipes the user's work-in-progress.
  const pendingRestartFieldIds = computed<Set<string>>(() => {
    const inst = toValue(opts.installation)
    if (!inst) return new Set()
    const inner = restartBaselines.value.get(inst.id)
    return inner ? new Set(inner.keys()) : new Set()
  })

  const fieldErrorMessages = computed<Map<string, string>>(() => {
    const inst = toValue(opts.installation)
    if (!inst) return new Map()
    return errorMessages.value.get(inst.id) ?? new Map()
  })

  watch(
    () => toValue(opts.installation)?.id ?? null,
    () => {
      void reload()
    },
    { immediate: true }
  )

  // Background enrichment in the main process (release-cache.enrichCommitsAhead)
  // fires this event when it actually writes a new `commitsAhead` value, so the
  // open settings pane can upgrade the "Latest from GitHub" card from
  // `tag (sha)` to `tag + N commits (sha)` in place — without the section IPC
  // having to await git fetches.
  //
  // We use `reload()` instead of `refreshSection('update')` because
  // `refreshSection` keys on the section's (locale-dependent) title rather
  // than a stable identifier. `reload()` is race-safe via `requestSeq`, and
  // its only added cost over a targeted refresh is the warm-cache disk-space
  // call (sub-ms after the first open) — sections themselves are an in-memory
  // build on the main side.
  const offReleaseEnriched = window.api.onReleaseCacheEnriched?.(() => {
    if (toValue(opts.installation)) void reload()
  })
  onScopeDispose(() => {
    offReleaseEnriched?.()
    if (noticeTimer) clearTimeout(noticeTimer)
  })

  // Drop the per-install dirty + error entries the moment that install
  // stops — a stopped install picks up new values on next launch, so
  // there is nothing left to apply or surface.
  watch(
    () => {
      const inst = toValue(opts.installation)
      return inst ? sessionStore.isRunning(inst.id) : false
    },
    (running, wasRunning) => {
      const inst = toValue(opts.installation)
      if (!inst) return
      if (wasRunning && !running) {
        if (restartBaselines.value.has(inst.id)) {
          const next = new Map(restartBaselines.value)
          next.delete(inst.id)
          restartBaselines.value = next
        }
        if (errorMessages.value.has(inst.id)) {
          const next = new Map(errorMessages.value)
          next.delete(inst.id)
          errorMessages.value = next
        }
      }
    }
  )

  const sectionsFresh = computed<boolean>(() => {
    const inst = toValue(opts.installation)
    return !!inst && sectionsPayloadId.value === inst.id
  })

  return {
    sections,
    diskSpace,
    loading,
    error,
    sectionsFresh,
    notice,
    reload,
    refreshSection,
    updateField,
    renameInstallation,
    pendingRestartFieldIds,
    fieldErrorMessages,
    runAction,
    runningActionIds,
    sectionsForTab,
    diskUsageItem,
    pinBottomSection,
    pinBottomActions
  }
}
