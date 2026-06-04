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
 * Title-bar status pills. The app-update pill shows on `ready`/`available`/`downloading`
 * (hidden when `kind` is null). The install-update pill fires on the active install's
 * update status tag, gated on `!isInstallLess`.
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
    // 'available' only fires with auto-updates OFF.
    return t('titleBar.desktopUpdateAvailable')
  })

  /** Adds the version to the tooltip when known, keeping the pill itself compact. */
  const appUpdatePillTooltip = computed<string>(() => {
    const label = appUpdatePillLabel.value
    if (!label) return ''
    const v = appUpdateState.value.version
    return v
      ? t('titleBar.desktopUpdateWithVersion', { label, version: v })
      : label
  })

  /** "Update {version}" when a target version is known, else generic "Update available". */
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
