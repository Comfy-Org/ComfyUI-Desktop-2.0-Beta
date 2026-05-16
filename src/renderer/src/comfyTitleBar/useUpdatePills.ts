import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

interface AppUpdateState {
  kind: 'available' | 'downloading' | 'ready' | null
  version: string | null
  autoUpdate: boolean
}

interface InstallUpdateState {
  available: boolean
  version: string | null
}

interface UpdatePillsBridge {
  onAppUpdateStateChanged: (cb: (state: AppUpdateState) => void) => () => void
  onInstallUpdateAvailable: (cb: (state: InstallUpdateState) => void) => () => void
  clickAppUpdatePill: () => void
  clickInstallUpdatePill: () => void
}

interface UseUpdatePillsOpts {
  bridge: UpdatePillsBridge | undefined
  isInstallLess: Ref<boolean>
}

interface UpdatePillsApi {
  appUpdateState: Ref<AppUpdateState>
  installUpdateState: Ref<InstallUpdateState>
  appUpdatePillLabel: ComputedRef<string | null>
  appUpdatePillTooltip: ComputedRef<string>
  installUpdatePillLabel: ComputedRef<string>
  showAppUpdatePill: ComputedRef<boolean>
  showInstallUpdatePill: ComputedRef<boolean>
  handleAppUpdatePill: () => void
  handleInstallUpdatePill: () => void
}

/**
 * Title-bar status pills.
 *
 * The app-update pill (right of the hamburger) shows when the
 * auto-updater has either downloaded an update (`'ready'`, prompts
 * Restart-to-update via the popover) or detected one is available
 * (`'available'`, prompts Download via the popover). State is pushed
 * from main on `comfy-titlebar:app-update-state-changed`; the pill
 * disappears entirely when `kind` is `null` so the title bar reads
 * clean in the steady state.
 *
 * The install-update pill (right of the install pill in the center)
 * fires when the active install's `statusTag.style === 'update'` —
 * the same signal the chooser tile's "Update" pill consumes. State is
 * pushed from main on `comfy-titlebar:install-update-changed` and is
 * gated on `!isInstallLess` (install-less hosts have no install backing
 * the window, so an install-scoped pill is meaningless there).
 */
export function useUpdatePills(opts: UseUpdatePillsOpts): UpdatePillsApi {
  const { t } = useI18n()
  const appUpdateState = ref<AppUpdateState>({ kind: null, version: null, autoUpdate: true })
  const installUpdateState = ref<InstallUpdateState>({ available: false, version: null })

  let unsubAppUpdate: (() => void) | undefined
  let unsubInstallUpdate: (() => void) | undefined

  const appUpdatePillLabel = computed<string | null>(() => {
    const s = appUpdateState.value
    if (!s.kind) return null
    if (s.kind === 'ready') return t('titleBar.desktopUpdateReady')
    if (s.kind === 'downloading') return t('titleBar.desktopUpdateDownloading')
    // 'available' — only fires with auto-updates OFF (main suppresses
    // it when ON and triggers the download itself).
    return t('titleBar.desktopUpdateAvailable')
  })

  /** Augments the pill label with the version when one is known, so
   *  the compact pill stays scan-friendly while the full "Desktop
   *  Update Ready (v1.2.3)" detail is one hover away. */
  const appUpdatePillTooltip = computed<string>(() => {
    const label = appUpdatePillLabel.value
    if (!label) return ''
    const v = appUpdateState.value.version
    return v
      ? t('titleBar.desktopUpdateWithVersion', { label, version: v })
      : label
  })

  /** Mirrors the app-update pill's "Update {version}" format when
   *  main carries a target version through the install's status tag,
   *  falling back to the generic "Update available" label. */
  const installUpdatePillLabel = computed<string>(() => {
    const v = installUpdateState.value.version
    return v
      ? t('titleBar.installUpdateVersion', { version: v })
      : t('titleBar.installUpdateAvailable')
  })

  const showAppUpdatePill = computed(() => appUpdateState.value.kind !== null)
  const showInstallUpdatePill = computed(
    () => !opts.isInstallLess.value && installUpdateState.value.available,
  )

  function handleAppUpdatePill(): void {
    opts.bridge?.clickAppUpdatePill()
  }
  function handleInstallUpdatePill(): void {
    opts.bridge?.clickInstallUpdatePill()
  }

  onMounted(() => {
    if (!opts.bridge) return
    unsubAppUpdate = opts.bridge.onAppUpdateStateChanged((next) => {
      appUpdateState.value = next
    })
    unsubInstallUpdate = opts.bridge.onInstallUpdateAvailable((next) => {
      installUpdateState.value = next
    })
  })

  onUnmounted(() => {
    unsubAppUpdate?.()
    unsubInstallUpdate?.()
  })

  return {
    appUpdateState,
    installUpdateState,
    appUpdatePillLabel,
    appUpdatePillTooltip,
    installUpdatePillLabel,
    showAppUpdatePill,
    showInstallUpdatePill,
    handleAppUpdatePill,
    handleInstallUpdatePill,
  }
}
