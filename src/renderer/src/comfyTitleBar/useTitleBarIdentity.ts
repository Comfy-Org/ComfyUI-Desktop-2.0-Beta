import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { installTypeMetaFor } from '../lib/installTypeIcon'

type FirstUseMode = 'none' | 'consent-lockdown' | 'post-consent'

interface InstallTypeMeta {
  icon: ReturnType<typeof installTypeMetaFor>['icon']
  labelKey: ReturnType<typeof installTypeMetaFor>['labelKey']
}

interface TitleBarIdentityBridge {
  onTitleChanged: (cb: (title: string) => void) => () => void
  onSourceCategoryChanged: (cb: (category: string | null) => void) => () => void
  onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => () => void
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  onFirstUseModeChanged: (cb: (mode: FirstUseMode) => void) => () => void
  onPreviewModeChanged: (cb: (preview: boolean) => void) => () => void
}

interface UseTitleBarIdentityOpts {
  bridge: TitleBarIdentityBridge | undefined
  /** Set on construction from `bridge.getInstallationId()`; the icon is
   *  suppressed and the center pill reads as the static identity label
   *  when this is true. */
  isInstallLess: Ref<boolean>
}

interface TitleBarIdentityApi {
  installLabel: Ref<string>
  sourceCategory: Ref<string | null>
  themeBg: Ref<string | null>
  themeText: Ref<string | null>
  isFullscreen: Ref<boolean>
  firstUseMode: Ref<FirstUseMode>
  isPreviewMode: Ref<boolean>
  isConsentLockdown: ComputedRef<boolean>
  installTypeMeta: ComputedRef<InstallTypeMeta>
  installTypeLabel: ComputedRef<string>
  showInstallTypeIcon: ComputedRef<boolean>
  isLight: ComputedRef<boolean>
}

/**
 * Title-bar identity / theme / lifecycle state pushed by main.
 *
 * Owns:
 *   - Install identity (`installLabel`, `sourceCategory`) and the
 *     derived install-type icon metadata that sits next to the
 *     center pill.
 *   - Theme colours pushed by main on theme change; `isLight` is the
 *     luminance test that drives the lighter hover / chrome treatment.
 *   - Fullscreen flag (used by the host CSS).
 *   - First-use takeover step (`firstUseMode`); `isConsentLockdown`
 *     hides the waffle menu so the user has to either accept consent
 *     or close the window via OS chrome — there's no in-app affordance
 *     that drops them past the T&C without a recorded answer.
 */
export function useTitleBarIdentity(opts: UseTitleBarIdentityOpts): TitleBarIdentityApi {
  const { t } = useI18n()

  const installLabel = ref('ComfyUI')
  const sourceCategory = ref<string | null>(null)
  const themeBg = ref<string | null>(null)
  const themeText = ref<string | null>(null)
  const isFullscreen = ref(false)
  const firstUseMode = ref<FirstUseMode>('none')
  /** Mirrors `entry.previewMode` on main — `true` while an in-progress
   *  install identity preview is active on a chooser host. The title
   *  bar treats a preview as identity-equivalent to a real attach for
   *  install-less-suppressed chrome (e.g. the install-type icon) so
   *  the user sees the chosen install's identity, not the bare chooser
   *  host, while the op runs. */
  const isPreviewMode = ref(false)

  const isConsentLockdown = computed(() => firstUseMode.value === 'consent-lockdown')

  const installTypeMeta = computed<InstallTypeMeta>(() => installTypeMetaFor(sourceCategory.value))

  const installTypeLabel = computed(() =>
    t(installTypeMeta.value.labelKey, t('installType.unknown')),
  )

  /** Suppressed on install-less host windows so the static identity
   *  label reads bare — except when an install identity preview is
   *  active, in which case the icon shows alongside the previewed
   *  install name so the chrome reads as the install's identity for
   *  the duration of the op. */
  const showInstallTypeIcon = computed(
    () =>
      (!opts.isInstallLess.value || isPreviewMode.value) && sourceCategory.value !== null,
  )

  /** Body luminance test — drives is-light styling (lighter hover state).
   *  Locked to `false` for now: the title bar surface is hard-coded to the
   *  dark token (`--titlebar-bg: var(--neutral-800)`) in both themes, so the light
   *  hover variants would produce light chrome on a dark bar.
   *  TODO(titlebar-light-theme): restore the luminance branch below when
   *  every title-bar surface is theme-aware. */
  const isLight = computed(() => false)
  // Original luminance test, kept inline for the restoration.
  // const isLight = computed(() => {
  //   const bg = themeBg.value
  //   if (!bg) return false
  //   const ctx = document.createElement('canvas').getContext('2d')
  //   if (!ctx) return false
  //   ctx.fillStyle = bg
  //   const hex = ctx.fillStyle as string
  //   if (!hex.startsWith('#') || hex.length < 7) return false
  //   const r = parseInt(hex.slice(1, 3), 16)
  //   const g = parseInt(hex.slice(3, 5), 16)
  //   const b = parseInt(hex.slice(5, 7), 16)
  //   return (r * 299 + g * 587 + b * 114) / 1000 >= 128
  // })

  let unsubTitle: (() => void) | undefined
  let unsubSourceCategory: (() => void) | undefined
  let unsubTheme: (() => void) | undefined
  let unsubFullscreen: (() => void) | undefined
  let unsubFirstUseMode: (() => void) | undefined
  let unsubPreviewMode: (() => void) | undefined

  onMounted(() => {
    if (!opts.bridge) return
    unsubTitle = opts.bridge.onTitleChanged((title) => {
      installLabel.value = title || 'ComfyUI'
    })
    unsubSourceCategory = opts.bridge.onSourceCategoryChanged((category) => {
      sourceCategory.value = category
    })
    unsubTheme = opts.bridge.onThemeChanged(({ bg, text }) => {
      themeBg.value = bg
      themeText.value = text
    })
    unsubFullscreen = opts.bridge.onFullscreenChanged((fullscreen) => {
      isFullscreen.value = fullscreen
    })
    unsubFirstUseMode = opts.bridge.onFirstUseModeChanged((mode) => {
      firstUseMode.value = mode
    })
    unsubPreviewMode = opts.bridge.onPreviewModeChanged((preview) => {
      isPreviewMode.value = preview
    })
  })

  onUnmounted(() => {
    unsubTitle?.()
    unsubSourceCategory?.()
    unsubTheme?.()
    unsubFullscreen?.()
    unsubFirstUseMode?.()
    unsubPreviewMode?.()
  })

  return {
    installLabel,
    sourceCategory,
    themeBg,
    themeText,
    isFullscreen,
    firstUseMode,
    isPreviewMode,
    isConsentLockdown,
    installTypeMeta,
    installTypeLabel,
    showInstallTypeIcon,
    isLight,
  }
}
