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

// Backing state + IPC plumbing for the Settings drawer. All tabs source
// from `getDetailSections()` and write through `update-installation` /
// `runAction`; the action chain mirrors `DetailModal.runAction`.

export interface UseComfyUISettingsOpts {
  installation: MaybeRefOrGetter<Installation | null>
  onShowProgress: (opts: ShowProgressOpts) => void
  /** Install was removed (delete/untrack); host closes the drawer + window. */
  onNavigateList?: () => void
  onClose?: () => void
}

export interface UseComfyUISettingsApi {
  sections: Ref<DetailSection[]>
  diskSpace: Ref<DiskSpaceInfo | null>
  loading: Ref<boolean>
  error: Ref<string | null>

  /** True when the painted payload belongs to the selected install. Lags
   *  during a picker switch (prior payload stays painted to avoid a
   *  "Loading…" flash); hosts gate per-install actions on this. */
  sectionsFresh: ComputedRef<boolean>

  /** Transient, non-blocking inline status line, auto-cleared. */
  notice: Ref<string | null>

  reload: () => Promise<void>

  /** Splices only the named section in-place (preserving other subtrees);
   *  falls back to full `reload()` when the title isn't in the new payload. */
  refreshSection: (sectionTitle: string | undefined) => Promise<void>

  updateField: (field: DetailField, value: unknown) => Promise<void>

  /** Running-install field ids edited away from their launched value;
   *  drives the "Restart to apply" pill. Held per-install. */
  pendingRestartFieldIds: ComputedRef<Set<string>>

  /** Consume the pending-restart + error state for an install. Called when the
   *  user initiates the restart, since a remote relaunch surfaces no observable
   *  lifecycle dip to clear it automatically. */
  clearPendingRestart: (installId: string) => void

  /** Per-install field error messages from failed `updateField` IPCs. */
  fieldErrorMessages: ComputedRef<Map<string, string>>

  /** Commit a new name. True on commit, false on no-op / rejection. */
  renameInstallation: (newName: string) => Promise<boolean>

  runAction: (action: ActionDef) => Promise<void>

  /** Inline-path action ids in flight; drives per-button spinners. */
  runningActionIds: Ref<Set<string>>

  sectionsForTab: (tab: SectionTab) => ComputedRef<DetailSection[]>

  /** Synthetic Disk-Usage row (sourced from a separate IPC). */
  diskUsageItem: ComputedRef<{ label: string; value: string } | null>

  pinBottomSection: ComputedRef<DetailSection | null>

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
  // Install's own on-disk footprint (a directory-tree walk), null until it
  // lands. Used instead of volume `total - free`, which is whole-disk usage.
  const installSize = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
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
  // Replaced (not mutated) so Vue's shallow Set reactivity tracks changes.
  const runningActionIds = ref<Set<string>>(new Set())
  // Restart-required dirty tracking, keyed by install id then field id; the
  // value is the launched baseline. Reverting to it drops the entry.
  // Per-install keying survives picker toggles.
  const restartBaselines = ref<Map<string, Map<string, unknown>>>(new Map())
  // Per-install field error messages, same keying as restartBaselines.
  const errorMessages = ref<Map<string, Map<string, string>>>(new Map())
  // Auto-clear timers for error pills, keyed by `installId:fieldId`.
  const errorClearTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Optimistic-write rollback deadline; a local IPC + JSON merge shouldn't take this long.
  const UPDATE_TIMEOUT_MS = 5000
  const ERROR_TAG_TTL_MS = 4000
  // Last id `loadAll` ran with; lets `refreshSection` drop late splices after a switch.
  let lastLoadedId: string | null = null
  // Id of the install whose payload is currently painted; backs `sectionsFresh`.
  const sectionsPayloadId = ref<string | null>(null)
  // Request id: each load captures the next value and only writes back if
  // still latest, so an A→B→A late response can't overwrite the pane.
  let requestSeq = 0

  async function loadAll(installationId: string, installPath: string): Promise<void> {
    // Deliberately don't blank sections on switch: blanking flashed
    // "Loading…" on every picker click. The prior payload stays painted
    // (host crossfades by install id) and `sectionsPayloadId` lags so hosts
    // can gate on freshness until the new payload lands.
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
    // Footprint scan runs after the main load so it can't block first render.
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
      // Bump the sequence so an in-flight loadAll can't write into our refs.
      requestSeq++
      return
    }
    await loadAll(inst.id, inst.installPath ?? '')
  }

  // Splices only the matching section in-place to preserve other subtrees.
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
      // Drop stale/out-of-order results so they can't splice into the wrong pane.
      if (seq !== requestSeq || lastLoadedId !== targetId) return
      const updated = fresh.find((s) => s.title === sectionTitle)
      if (!updated) {
        // Title gone from the new payload; full replace to stay coherent.
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

  // Field-value equality for restart tracking; `===` for primitives, a flat
  // key-by-key walk for objects like `envVars`.
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

  // Races a promise against a deadline; throws an `isTimeout`-tagged Error on it.
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

  // Returns the live field ref so callers can mutate `field.value` in place.
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

    // Prior value: both the dirty-tracking baseline and the rollback target.
    const liveField = findFieldInSections(field.id)
    const priorValue = liveField ? liveField.value : (field.value as unknown)
    // Optimistic write so the control re-renders this frame; reconciled below.
    if (liveField) liveField.value = value as DetailField['value']

    // Re-editing clears the prior error pill.
    clearFieldError(installId, field.id)

    try {
      await withTimeout(
        window.api.updateInstallation(installId, { [field.id]: value }),
        UPDATE_TIMEOUT_MS
      )
    } catch (err: unknown) {
      const live = findFieldInSections(field.id)
      if (live) live.value = priorValue as DetailField['value']
      // A rejected write never engages the restart-required state.
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
    // Restart-required dirty tracking, only after a successful IPC.
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
    // A field can declare an `onChangeAction` to fire after its value changes
    // (e.g. switching channel triggers `check-update`).
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
    // `refreshSection` splices only that section to preserve other subtrees.
    if (field.refreshSection) {
      const owningSection = sections.value.find((s) => s.fields?.some((f) => f.id === field.id))
      await refreshSection(owningSection?.title)
    } else {
      await reload()
    }
  }

  // The IPC handler owns the duplicate-name guard; a rejection alerts here.
  // True on commit, false on no-op (empty/unchanged) or rejection.
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

    // Share is a renderer-side IPC (export + native dialog), not a source
    // action, so intercept it before the dispatch chain. Cancel is a no-op.
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

    // 1. Busy-only guard. migrate-to-standalone owns its own busy check + UI,
    //    so skip this pre-flight and the step-3 augment (its apiCall still self-stops).
    const ownsPreflight = action.id === 'migrate-to-standalone'
    const requiresStoppedGuard = REQUIRES_STOPPED.has(action.id)
    const wasRunning = sessionStore.isRunning(inst.id)
    if (requiresStoppedGuard && !ownsPreflight) {
      const proceed = await actionGuard.checkBeforeAction(inst.id, action.label)
      if (!proceed) return
    }

    let mutableAction: ActionDef = { ...action }

    // 2. migrate-to-standalone uses its own takeover; merge its form data.
    if (mutableAction.id === 'migrate-to-standalone') {
      const migrateResult = await confirmMigration(inst, mutableAction.confirm)
      if (!migrateResult) return
      mutableAction = {
        ...mutableAction,
        data: { ...mutableAction.data, ...migrateResult }
      }
    }

    // 3. Stop-warning augment: prepend the stop sentence to the action's copy
    //    (or use it standalone). Skipped for migrate, which owns its surface.
    if (requiresStoppedGuard && wasRunning && !ownsPreflight) {
      mutableAction = augmentActionWithStopWarning(
        mutableAction,
        t('errors.willStopRunning', { name: inst?.name || 'ComfyUI' })
      )
    }

    // 4-8. Shopping-list chain: fieldSelects → select → prompt → confirm →
    //      disk-check. Each returns the merged action or null on cancel.
    //      Confirm skips migrate (handled in step 2); confirm + disk-check
    //      stay on `useModal` for `confirmWithOptions` parity.
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

    // 9. showProgress: the synthetic `restart` id maps to stop → wait → launch.
    //    REQUIRES_STOPPED ops against a running install wrap apiCall to
    //    stop → wait → run, and append a relaunch for IN_PLACE_RELAUNCH.
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
        // The synthetic `restart` reads as a launch to the caption pipeline.
        opKind: isRestart ? 'launch' : progressOpKindForActionId(mutableAction.id),
        destroysInstance: destroysInstanceForActionId(mutableAction.id),
        actionId: mutableAction.id,
        actionData: mutableAction.data
      })
      return
    }

    // 10. Inline invoke. Self-stops too, so a running install's backend
    //     check can't race the stop.
    runningActionIds.value = new Set(runningActionIds.value).add(mutableAction.id)
    // Floor the spinner's lifetime so a sub-frame backend response doesn't
    // hide it and read as a no-op (see MIN_BUSY_FEEDBACK_MS in uiTiming.ts).
    const busyStartedAt = Date.now()
    try {
      emitTelemetryAction('comfy.desktop.action.invoked', telemetryContext)
      if (wasRunning && requiresStoppedGuard) {
        await stopAndWaitForExit(inst.id, () => sessionStore.isRunning(inst.id))
      }
      const result = await window.api.runAction(inst.id, mutableAction.id, mutableAction.data)
      if (result.running) {
        // Backend race: a launch slipped in after the stop; surface the guard.
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
        // A reload can also carry a message (e.g. "already up to date");
        // surface it as a transient notice, not an interrupting modal.
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
    // `pinBottom` sections live in the footer, not the tab body.
    return computed(() => sections.value.filter((s) => s.tab === tab && !s.pinBottom))
  }

  const pinBottomSection = computed<DetailSection | null>(
    () => sections.value.find((s) => s.pinBottom) ?? null
  )

  // Footer actions, minus launch/restart (the primary CTA owns those).
  const pinBottomActions = computed<ActionDef[]>(() => {
    const acts = (pinBottomSection.value?.actions ?? []).filter(
      (a) => a.id !== 'launch' && a.id !== 'restart'
    )
    const inst = toValue(opts.installation)
    if (!inst) return acts
    return acts
  })

  const diskUsageItem = computed<{ label: string; value: string } | null>(() => {
    // Prefer the install's own footprint; volume `total - free` is whole-disk usage.
    if (installSize.value !== null) {
      return {
        label: t('comfyUISettings.diskUsage', 'Disk Usage'),
        value: formatBytes(installSize.value)
      }
    }
    // Placeholder while the scan is in flight so the row doesn't pop in.
    if (!diskSpace.value) return null
    return {
      label: t('comfyUISettings.diskUsage', 'Disk Usage'),
      value: '—'
    }
  })

  // Derived from the per-install baseline map for the selected install.
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

  // Main fires this when background enrichment writes a new commitsAhead, so
  // the open pane can upgrade its release card in place. Uses `reload()`
  // (race-safe via requestSeq) rather than refreshSection, which keys on a
  // locale-dependent title.
  const offReleaseEnriched = window.api.onReleaseCacheEnriched?.(() => {
    if (toValue(opts.installation)) void reload()
  })
  onScopeDispose(() => {
    offReleaseEnriched?.()
    if (noticeTimer) clearTimeout(noticeTimer)
  })

  // Drop the per-install dirty + error entries once a (re)launch has consumed
  // the new values, so the "Restart to apply" state clears after the restart.
  function clearRestartAndErrors(installId: string): void {
    if (restartBaselines.value.has(installId)) {
      const next = new Map(restartBaselines.value)
      next.delete(installId)
      restartBaselines.value = next
    }
    if (errorMessages.value.has(installId)) {
      const next = new Map(errorMessages.value)
      next.delete(installId)
      errorMessages.value = next
    }
  }

  watch(
    () => {
      const inst = toValue(opts.installation)
      return inst ? sessionStore.isRunning(inst.id) : false
    },
    (running, wasRunning) => {
      const inst = toValue(opts.installation)
      if (!inst) return
      // Refetch so the "Running details" port row (sourced from main) appears
      // on launch and clears on stop. Race-safe via reload()'s requestSeq.
      void reload()
      // Stop edge: nothing is left to apply (next launch picks up new values).
      if (wasRunning && !running) clearRestartAndErrors(inst.id)
    }
  )

  // A restart may not surface a running→stopped dip (e.g. a remote connection
  // has no process to kill, so the snapshot can coalesce stop+relaunch into one
  // running broadcast). Catch the relaunch via the launching edge instead: any
  // (re)launch re-reads the persisted values, so the pending-restart state is
  // satisfied the moment a new launch begins.
  watch(
    () => {
      const inst = toValue(opts.installation)
      return inst ? sessionStore.isLaunching(inst.id) : false
    },
    (launching, wasLaunching) => {
      const inst = toValue(opts.installation)
      if (!inst) return
      if (launching && !wasLaunching) clearRestartAndErrors(inst.id)
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
    clearPendingRestart: clearRestartAndErrors,
    fieldErrorMessages,
    runAction,
    runningActionIds,
    sectionsForTab,
    diskUsageItem,
    pinBottomSection,
    pinBottomActions
  }
}
