import {
  fs,
  installations, settings,
  sourceMap,
  detectDesktopInstall,
  isGitAvailable, tryConfigurePygit2Fallback,
  createCache, fetchJSON,
  setCallbacks, _broadcastToRenderer,
  migrateDefaults, checkInstallationUpdates,
  isEffectivelyEmptyInstallDir,
  autoAssignPrimary,
  UPDATE_CHECK_INTERVAL,
} from './shared'
import type { RegisterCallbacks } from './shared'
import { registerAppHandlers } from './registerAppHandlers'
import { registerInstallationHandlers } from './registerInstallationHandlers'
import { registerSnapshotHandlers } from './registerSnapshotHandlers'
import { registerSettingsHandlers } from './registerSettingsHandlers'
import { registerSessionHandlers } from './registerSessionHandlers'

// Re-export public API from shared
export { getAppVersion, stopRunning, hasRunningSessions, getSessionProcess, hasActiveOperations, getActiveDetails, cancelAll } from './shared'
export type { RegisterCallbacks } from './shared'

export function register(callbacks: RegisterCallbacks = {}): void {
  setCallbacks(callbacks)

  installations.seedDefaults([
    {
      name: 'Comfy Cloud',
      sourceId: 'cloud',
      remoteUrl: 'https://cloud.comfy.org/',
      launchMode: 'window',
      browserPartition: 'shared',
    },
  ])
  installations.ensureExists('cloud', {
    name: 'Comfy Cloud',
    sourceId: 'cloud',
    remoteUrl: 'https://cloud.comfy.org/',
    launchMode: 'window',
    browserPartition: 'shared',
    status: 'installed',
  })

  // Auto-track Desktop install if detected
  {
    const desktopInfo = detectDesktopInstall()
    if (desktopInfo) {
      installations.ensureExists('desktop', {
        name: 'ComfyUI Legacy Desktop',
        sourceId: 'desktop',
        installPath: desktopInfo.basePath,
        launchMode: 'external',
        desktopExePath: desktopInfo.executablePath || undefined,
        status: 'installed',
      })
    }
  }

  migrateDefaults()

  // Sweep empty/broken local installations on startup, then clean stale settings references
  void (async () => {
    try {
      const all = await installations.list()
      let swept = false
      for (const inst of all) {
        const source = sourceMap[inst.sourceId]
        if (!source || source.skipInstall) continue
        if (!inst.installPath) continue
        if (!isEffectivelyEmptyInstallDir(inst.installPath)) continue
        try { fs.rmSync(inst.installPath, { recursive: true, force: true }) } catch {}
        await installations.remove(inst.id)
        swept = true
      }

      const remaining = swept ? await installations.list() : all
      const validIds = new Set(remaining.map((i) => i.id))
      let settingsChanged = false

      const currentPrimary = settings.get('primaryInstallId')
      if (currentPrimary && !validIds.has(currentPrimary)) {
        await autoAssignPrimary(currentPrimary)
        settingsChanged = true
      }

      const rawPinned = settings.get('pinnedInstallIds')
      const pinned = Array.isArray(rawPinned) ? rawPinned as string[] : []
      const filtered = pinned.filter((id) => validIds.has(id))
      if (filtered.length !== pinned.length) {
        settings.set('pinnedInstallIds', filtered)
        settingsChanged = true
      }

      if (swept || settingsChanged) _broadcastToRenderer('installations-changed', {})
    } catch {}
  })()

  // Configure pygit2 fallback if system git is unavailable
  void (async () => {
    try {
      if (await isGitAvailable()) return
      const all = await installations.list()
      for (const inst of all) {
        if (inst.sourceId !== 'standalone' || !inst.installPath) continue
        if (tryConfigurePygit2Fallback(inst.installPath)) {
          console.log('[ipc] System git not found — configured pygit2 fallback via', inst.installPath)
          break
        }
      }
    } catch {}
  })()

  // Clean up partial downloads
  void (async () => {
    try {
      const cache = createCache(settings.get('cacheDir') as string, settings.get('maxCachedFiles') as number)
      await cache.cleanPartials()
    } catch {}
  })()

  // Pre-warm the ETag cache
  void (async () => {
    try {
      await Promise.allSettled([
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI-Standalone-Environments/releases?per_page=30'),
        fetchJSON('https://api.github.com/repos/Comfy-Org/ComfyUI-Standalone-Environments/releases/latest'),
      ])
    } catch {}
  })()

  // Check installation updates on startup and periodically
  setTimeout(() => checkInstallationUpdates(), 3_000)
  setInterval(() => checkInstallationUpdates(), UPDATE_CHECK_INTERVAL)

  // Register all handler groups
  registerAppHandlers()
  registerInstallationHandlers()
  registerSnapshotHandlers()
  registerSettingsHandlers()
  registerSessionHandlers()
}
