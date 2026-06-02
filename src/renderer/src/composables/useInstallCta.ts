import { computed, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import type { Installation } from '../types/ipc'

/**
 * Per-window primary-action state for an installation.
 *
 * An install can be running in at most one window at a time
 * (`getEntryByInstallationId` on the main side enforces this), so the
 * answer to "what should the primary CTA do?" decomposes into three
 * cases driven by the global `sessionStore.isRunning(id)` flag and the
 * host window's own `activeInstallationId`:
 *
 *   - not running anywhere       → **Start**, launch via `pickInstall`
 *   - running in this window     → **Restart**, stop + relaunch in place
 *   - running in another window  → **Switch**, focus the existing window
 *
 * Centralizing the decision here so the picker row indicators and the
 * settings footer CTA can't drift apart (issue #755 — the original
 * #749 mislabel that #753 patched, plus the duplicated logic that
 * patch left behind across `InstancePickerView` and
 * `ComfyUISettingsContent`).
 */
export interface InstallCta {
  /** True when the install is running in the host window that owns
   *  this composable. Only here does "Restart" make sense. */
  runningInThisWindow: ComputedRef<boolean>
  /** True when the install is running in some *other* host window —
   *  the right action is to focus that window, not restart. */
  runningElsewhere: ComputedRef<boolean>
  /** True when the install has a running session anywhere. Use this
   *  for genuinely global gates (delete / snapshot-restore) that
   *  shouldn't fire while the install is in use anywhere. */
  runningAnywhere: ComputedRef<boolean>
  /** Localized primary-action label: `Start` / `Restart` / `Switch`.
   *  Components can override (e.g. settings shows "Restart to apply
   *  changes" when there's a pending-restart field). */
  label: ComputedRef<string>
  /** Passed back to the host so it can dispatch `restartInstall`
   *  (true) vs `pickInstall` (false). True iff running in this
   *  window. */
  restartInPlace: ComputedRef<boolean>
}

export function useInstallCta(
  installation: Ref<Installation | null | undefined>,
  opts: { activeInstallationId: Ref<string | null | undefined> },
): InstallCta {
  const { t } = useI18n()
  const sessionStore = useSessionStore()

  const runningAnywhere = computed(() => {
    const inst = installation.value
    return inst ? sessionStore.isRunning(inst.id) : false
  })

  const runningInThisWindow = computed(() => {
    const inst = installation.value
    if (!inst || !runningAnywhere.value) return false
    const active = opts.activeInstallationId.value
    return active != null && inst.id === active
  })

  const runningElsewhere = computed(
    () => runningAnywhere.value && !runningInThisWindow.value,
  )

  const label = computed(() => {
    if (runningInThisWindow.value) return t('instancePicker.restart', 'Restart')
    if (runningElsewhere.value) return t('instancePicker.switch', 'Switch')
    return t('instancePicker.open', 'Start')
  })

  return {
    runningInThisWindow,
    runningElsewhere,
    runningAnywhere,
    label,
    restartInPlace: runningInThisWindow,
  }
}
