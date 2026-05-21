import {
  ipcMain, nativeTheme,
  sources, settings, i18n,
  getAppVersion, resolveTheme,
  _onLocaleChanged, _onThemeChanged, _broadcastToRenderer,
} from './shared'
import { updateTitleBarOverlay } from '../titleBarOverlay'
import * as mainTelemetry from '../telemetry'
import { detectFirstUseState } from '../firstUseDetection'
import * as updater from '../updater'
import { globalSettingsEvents } from '../globalSettingsEvents'
import type { SettingsSection } from '../../../types/ipc'

/** Assemble the App + sources + About sections (Language / Theme /
 *  Telemetry / Cache / Advanced / About) exactly the way the
 *  `'get-settings-sections'` IPC handler returned them. Extracted so
 *  the Global Settings popup snapshot builder can call the same code
 *  path without going through IPC. */
export function buildSettingsSections(): SettingsSection[] {
  const s = settings.getAll()
  const chineseMirrorsField = {
    id: 'useChineseMirrors', label: i18n.t('settings.useChineseMirrors'), type: 'boolean' as const, value: s.useChineseMirrors === true,
    ...(s.useChineseMirrors === true ? { description: i18n.t('settings.chineseMirrorsDescription') } : {}),
  }
  const isChinese = i18n.getLocale().startsWith('zh')
  const appSections: SettingsSection[] = [
    {
      title: i18n.t('settings.general'),
      fields: [
        { id: 'language', label: i18n.t('settings.language'), type: 'select', value: s.language || i18n.getLocale(),
          options: i18n.getAvailableLocales() },
        // Theme picker is hidden — the app is dark-only across every
        // title-bar surface (Vue pills, dropdown popups, tooltips, OS
        // overlay). The underlying `theme` setting key + the
        // applySettingSet broadcast + the nativeTheme listener stay
        // wired so a future re-introduction is just re-adding this
        // field, with no other plumbing changes.
        // Issue #488 — auto-check loop always runs; this toggle
        // controls whether updates install silently vs prompt the
        // user. The `autoUpdate` key is retained in the schema (no
        // UI) for a future setting.
        { id: 'autoInstallUpdates', label: i18n.t('settings.autoInstallUpdates'), type: 'boolean', value: s.autoInstallUpdates !== false },
        // The `onAppClose` field is hidden while docking-to-tray is
        // disabled (see main/index.ts createTray()). Restore this
        // entry — and the 'tray' default in settings.ts — when the
        // docked-app flow comes back.
        ...(isChinese ? [chineseMirrorsField] : []),
      ],
    },
    {
      title: i18n.t('settings.telemetry'),
      fields: [
        { id: 'telemetryEnabled', label: i18n.t('settings.telemetryEnabled'), type: 'boolean', value: s.telemetryEnabled !== false },
      ],
    },
    {
      // The contents are the on-disk cache (model files, wheels,
      // GitHub release tarballs, etc.) — blobs the launcher pulls
      // down on behalf of an install. "Cache" reflects what the
      // user actually controls here.
      title: i18n.t('settings.cache'),
      fields: [
        { id: 'cacheDir', label: i18n.t('settings.cacheDir'), type: 'path', value: s.cacheDir, openable: true },
        { id: 'maxCachedFiles', label: i18n.t('settings.maxCachedFiles'), type: 'number', value: s.maxCachedFiles, min: 1, max: 50 },
      ],
    },
    {
      title: i18n.t('settings.advanced'),
      fields: [
        { id: 'pypiMirror', label: i18n.t('settings.pypiMirror'), type: 'text' as const, value: s.pypiMirror || '',
          placeholder: i18n.t('settings.pypiMirrorPlaceholder') },
        ...(!isChinese ? [chineseMirrorsField] : []),
      ],
    },
  ]
  const sourceSections = sources.flatMap((src) => {
    const plugin = src as unknown as Record<string, unknown>
    if (typeof plugin.getSettingsSections === 'function') {
      return (plugin.getSettingsSections as (s: Record<string, unknown>) => SettingsSection[])(s as Record<string, unknown>)
    }
    return []
  })
  const version = getAppVersion()
  const aboutSection: SettingsSection = {
    title: i18n.t('settings.about'),
    fields: [
      { id: 'about-version', label: i18n.t('settings.version'), type: 'text', value: version, readonly: true },
      { id: 'about-platform', label: i18n.t('settings.platform'), type: 'text', value: `${process.platform} (${process.arch})`, readonly: true },
    ],
    actions: [
      { label: 'GitHub', url: 'https://github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta' },
    ],
  }
  return [...appSections, ...sourceSections, aboutSection]
}

/** Models directory payload (truly-global launcher setting). */
export function buildModelsPayload(): { systemDefault: string; sections: SettingsSection[] } {
  const s = settings.getAll()
  return {
    systemDefault: settings.defaults.modelsDirs[0] ?? '',
    sections: [
      {
        title: i18n.t('models.directories'),
        fields: [
          { id: 'modelsDirs', label: i18n.t('models.directoriesDesc'), type: 'pathList', value: s.modelsDirs || [] },
        ],
      },
    ],
  }
}

/** Shared input/output directories. */
export function buildMediaSections(): SettingsSection[] {
  const s = settings.getAll()
  return [
    {
      title: i18n.t('media.sharedDirs'),
      fields: [
        { id: 'inputDir', label: i18n.t('media.inputDir'), type: 'path' as const, value: s.inputDir || settings.defaults.inputDir, openable: true, tooltip: i18n.t('tooltips.inputDir') },
        { id: 'outputDir', label: i18n.t('media.outputDir'), type: 'path' as const, value: s.outputDir || settings.defaults.outputDir, openable: true, tooltip: i18n.t('tooltips.outputDir') },
      ],
    },
  ]
}

/** Apply a setting write + run all the side-effect branches that the
 *  legacy `'set-setting'` IPC handler performed (theme/locale/telemetry
 *  broadcasts + updater hint + `settings-changed` broadcast). Emits
 *  `globalSettingsEvents.emit('changed')` so the Global Settings popup
 *  rebuilds its snapshot. */
export function applySettingSet(key: string, value: unknown): void {
  settings.set(key, value)
  if (key === 'theme') {
    _broadcastToRenderer('theme-changed', resolveTheme())
    updateTitleBarOverlay()
    if (_onThemeChanged) _onThemeChanged()
  }
  if (key === 'language') {
    i18n.init(value as string)
    _broadcastToRenderer('locale-changed', i18n.getMessages())
    if (_onLocaleChanged) _onLocaleChanged()
  }
  if (key === 'telemetryEnabled') {
    _broadcastToRenderer('telemetry-setting-changed', value)
    mainTelemetry.setConsent(value !== false)
  }
  if (key === 'autoInstallUpdates' || key === 'autoUpdate') {
    // Re-broadcast the cached app-update state so a pending 'ready'
    // immediately starts reading as auto-on / auto-off — drives the
    // title-bar pill copy and the click-modal flow without waiting
    // for the next update-check broadcast. Both keys are watched so
    // a future re-exposure of the `autoUpdate` toggle still works
    // without further changes here.
    updater.notifyAutoUpdateChanged()
  }
  // Notify all renderers (including embedded panel views) so any open
  // settings UI can refresh and stay in sync. Cheap, fires on every
  // setting change — listeners should refetch what they care about.
  _broadcastToRenderer('settings-changed', { key })
  // Mirror the broadcast to the Global Settings popup snapshot
  // pipeline so the title-popup view re-renders without going through
  // a separate IPC subscription.
  globalSettingsEvents.emit('changed')
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('get-settings-sections', () => buildSettingsSections())
  ipcMain.handle('get-models-sections', () => buildModelsPayload())
  ipcMain.handle('get-media-sections', () => buildMediaSections())

  ipcMain.handle('set-setting', (_event, key: string, value: unknown) => {
    applySettingSet(key, value)
  })

  ipcMain.handle('get-setting', (_event, key: string) => {
    return settings.get(key)
  })

  ipcMain.handle('get-locale-messages', () => i18n.getMessages())
  ipcMain.handle('get-available-locales', () => i18n.getAvailableLocales())
  // The first-use takeover (FirstUseTakeover.vue) needs to ask main
  // for the resolved locale so it can decide whether
  // to insert the China-mirror sub-step. The renderer's vue-i18n locale
  // is always 'en' (we deep-merge messages onto the en bundle), so we
  // can't read it from there — main owns the truth via i18n.getLocale()
  // (which reflects the user's `language` setting + app.getLocale()
  // fallback as initialised in main/index.ts).
  ipcMain.handle('get-locale', () => i18n.getLocale())

  // The first-use takeover asks for a categorised snapshot of the
  // persisted installs so it can decide whether to skip the
  // cloud-vs-local pick (returning user) and whether to surface the
  // migrate-vs-install-new sub-step on the Local branch (Legacy
  // Desktop install present). See `firstUseDetection.ts`.
  ipcMain.handle('get-first-use-state', () => detectFirstUseState())

  ipcMain.handle('get-resolved-theme', () => resolveTheme())

  nativeTheme.on('updated', () => {
    if (((settings.get('theme') as string | undefined) || 'system') !== 'system') return
    _broadcastToRenderer('theme-changed', resolveTheme())
    updateTitleBarOverlay()
    if (_onThemeChanged) _onThemeChanged()
  })
}
