import {
  ipcMain,
  nativeTheme,
  sources,
  settings,
  i18n,
  getAppVersion,
  resolveTheme,
  _onLocaleChanged,
  _onThemeChanged,
  _broadcastToRenderer
} from './shared'
import { updateTitleBarOverlay } from '../titleBarOverlay'
import * as mainTelemetry from '../telemetry'
import { detectFirstUseState } from '../firstUseDetection'
import * as updater from '../updater'
import { globalSettingsEvents } from '../globalSettingsEvents'
import { recordIpcInvocation } from '../e2eOverrides'
import type { SettingsSection } from '../../../types/ipc'

// Build the App + sources + About settings sections. Shared so the Global
// Settings popup snapshot can call it without going through IPC.
export function buildSettingsSections(): SettingsSection[] {
  const s = settings.getAll()
  // Inline description only shows when ON so it reads as "currently in use".
  const chineseMirrorsField = {
    id: 'useChineseMirrors',
    label: i18n.t('settings.useChineseMirrors'),
    type: 'boolean' as const,
    value: s.useChineseMirrors === true,
    tooltip: i18n.t('settings.chineseMirrorsDescription'),
    ...(s.useChineseMirrors === true
      ? { description: i18n.t('settings.chineseMirrorsDescription') }
      : {})
  }
  const isChinese = i18n.getLocale().startsWith('zh')
  const appSections: SettingsSection[] = [
    {
      title: i18n.t('settings.general'),
      fields: [
        {
          id: 'language',
          label: i18n.t('settings.language'),
          type: 'select',
          value: s.language || i18n.getLocale(),
          options: i18n.getAvailableLocales()
        },
        // Theme picker hidden (app is dark-only); the theme plumbing stays
        // wired so re-adding this field is the only change needed to restore it.
        // autoInstallUpdates toggles silent-install vs prompt; the auto-check
        // loop itself always runs.
        {
          id: 'autoInstallUpdates',
          label: i18n.t('settings.autoInstallUpdates'),
          type: 'boolean',
          value: s.autoInstallUpdates !== false
        },
        // onAppClose field hidden while docking-to-tray is disabled.
        ...(isChinese ? [chineseMirrorsField] : [])
      ]
    },
    {
      title: i18n.t('settings.telemetry'),
      fields: [
        {
          id: 'telemetryEnabled',
          label: i18n.t('settings.telemetryEnabled'),
          type: 'boolean',
          value: s.telemetryEnabled !== false
        }
      ]
    },
    {
      title: i18n.t('settings.cache'),
      fields: [
        {
          id: 'cacheDir',
          label: i18n.t('settings.cacheDir'),
          type: 'path',
          value: s.cacheDir,
          openable: true
        }
      ]
    },
    {
      title: i18n.t('settings.advanced'),
      fields: [
        {
          id: 'pypiMirror',
          label: i18n.t('settings.pypiMirror'),
          type: 'text' as const,
          value: s.pypiMirror || '',
          placeholder: i18n.t('settings.pypiMirrorPlaceholder')
        },
        ...(!isChinese ? [chineseMirrorsField] : [])
      ]
    }
  ]
  const sourceSections = sources.flatMap((src) => {
    const plugin = src as unknown as Record<string, unknown>
    if (typeof plugin.getSettingsSections === 'function') {
      return (plugin.getSettingsSections as (s: Record<string, unknown>) => SettingsSection[])(
        s as Record<string, unknown>
      )
    }
    return []
  })
  const version = getAppVersion()
  const aboutSection: SettingsSection = {
    title: i18n.t('settings.about'),
    fields: [
      {
        id: 'about-version',
        label: i18n.t('settings.version'),
        type: 'text',
        value: version,
        readonly: true
      },
      {
        id: 'about-platform',
        label: i18n.t('settings.platform'),
        type: 'text',
        value: `${process.platform} (${process.arch})`,
        readonly: true
      }
    ],
    actions: [{ label: 'GitHub', url: 'https://github.com/Comfy-Org/Comfy-Desktop' }]
  }
  return [...appSections, ...sourceSections, aboutSection]
}

// Models directory payload (truly-global launcher setting).
export function buildModelsPayload(): { systemDefault: string; sections: SettingsSection[] } {
  const s = settings.getAll()
  return {
    systemDefault: settings.defaults.modelsDirs[0] ?? '',
    sections: [
      {
        title: i18n.t('models.directories'),
        fields: [
          {
            id: 'modelsDirs',
            label: i18n.t('models.directoriesDesc'),
            type: 'pathList',
            value: s.modelsDirs || []
          }
        ]
      }
    ]
  }
}

// Default suggested install location (global-only; intentionally NOT part of
// buildMediaSections so it doesn't leak into the per-instance Storage tab).
// Label/tooltip live on the section header, so the field itself is unlabelled.
export function buildInstallLocationFields(): SettingsSection[] {
  const s = settings.getAll()
  return [
    {
      fields: [
        {
          id: 'installDir',
          label: '',
          type: 'path' as const,
          value: s.installDir || settings.defaults.installDir,
          openable: true
        }
      ]
    }
  ]
}

// Shared input/output directories.
export function buildMediaSections(): SettingsSection[] {
  const s = settings.getAll()
  return [
    {
      title: i18n.t('media.sharedDirs'),
      fields: [
        {
          id: 'inputDir',
          label: i18n.t('media.inputDir'),
          type: 'path' as const,
          value: s.inputDir || settings.defaults.inputDir,
          openable: true,
          tooltip: i18n.t('tooltips.inputDir')
        },
        {
          id: 'outputDir',
          label: i18n.t('media.outputDir'),
          type: 'path' as const,
          value: s.outputDir || settings.defaults.outputDir,
          openable: true,
          tooltip: i18n.t('tooltips.outputDir')
        }
      ]
    }
  ]
}

// Write a setting and run its side-effect branches (theme/locale/telemetry
// broadcasts, updater hint, settings-changed) plus the Global Settings refresh.
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
    // Three-state: true => granted, false => denied, null/undefined => undecided
    // (so an un-prompted migrator isn't collapsed into "opted in").
    const state: mainTelemetry.ConsentState =
      value === true ? 'granted' : value === false ? 'denied' : 'undecided'
    mainTelemetry.setConsentState(state)
  }
  if (key === 'autoInstallUpdates' || key === 'autoUpdate') {
    // Re-broadcast so a pending 'ready' immediately reads as auto-on/off.
    updater.notifyAutoUpdateChanged()
  }
  _broadcastToRenderer('settings-changed', { key })
  globalSettingsEvents.emit('changed')
}

export function registerSettingsHandlers(): void {
  ipcMain.handle('get-settings-sections', () => buildSettingsSections())
  ipcMain.handle('get-models-sections', () => buildModelsPayload())
  ipcMain.handle('get-media-sections', () => buildMediaSections())

  ipcMain.handle('set-setting', (_event, key: string, value: unknown) => {
    recordIpcInvocation('set-setting', { key, value })
    applySettingSet(key, value)
  })

  ipcMain.handle('get-setting', (_event, key: string) => {
    return settings.get(key)
  })

  ipcMain.handle('get-locale-messages', () => i18n.getMessages())
  ipcMain.handle('get-available-locales', () => i18n.getAvailableLocales())
  // Main owns the resolved locale; the renderer's vue-i18n locale is always 'en'.
  ipcMain.handle('get-locale', () => i18n.getLocale())

  ipcMain.handle('get-first-use-state', () => detectFirstUseState())

  ipcMain.handle('get-resolved-theme', () => resolveTheme())

  nativeTheme.on('updated', () => {
    if (((settings.get('theme') as string | undefined) || 'system') !== 'system') return
    _broadcastToRenderer('theme-changed', resolveTheme())
    updateTitleBarOverlay()
    if (_onThemeChanged) _onThemeChanged()
  })
}
