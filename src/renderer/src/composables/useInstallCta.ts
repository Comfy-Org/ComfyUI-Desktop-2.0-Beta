import { computed, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '../stores/sessionStore'
import type { Installation } from '../types/ipc'

// Centralized primary-CTA decision (so picker rows and the settings footer
// can't drift). An install runs in at most one window, so the CTA is:
//   - no session anywhere      → Start
//   - session in this window   → Restart
//   - session in another window→ Switch
// "Session" includes launching, so the launching window reads Restart at once.
export interface InstallCta {
  /** Session (launching or running) in this host window. */
  runningInThisWindow: ComputedRef<boolean>
  /** Session in some other host window. */
  runningElsewhere: ComputedRef<boolean>
  /** Session anywhere; use for global gates (delete / snapshot-restore). */
  runningAnywhere: ComputedRef<boolean>
  /** Localized `Start` / `Restart` / `Switch` label. */
  label: ComputedRef<string>
  /** True iff running in this window; picks `restartInstall` vs `pickInstall`. */
  restartInPlace: ComputedRef<boolean>
}

export function useInstallCta(
  installation: Ref<Installation | null | undefined>,
  opts: { activeInstallationId: Ref<string | null | undefined> },
): InstallCta {
  const { t } = useI18n()
  const sessionStore = useSessionStore()

  // launching || running covers the full attached-session window; the
  // main-side attach precedes `instance-launching`, so the "this window?"
  // comparison is already honest when this flips true.
  const runningAnywhere = computed(() => {
    const inst = installation.value
    if (!inst) return false
    return sessionStore.isRunning(inst.id) || sessionStore.isLaunching(inst.id)
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
