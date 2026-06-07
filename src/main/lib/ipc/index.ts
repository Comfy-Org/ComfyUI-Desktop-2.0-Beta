import {
  fs,
  installations,
  settings,
  sourceMap,
  detectDesktopInstall,
  isGitAvailable,
  tryConfigureBootstrapPygit2,
  tryConfigurePygit2Fallback,
  createCache,
  fetchJSON,
  getLatestStableTag,
  setCallbacks,
  _broadcastToRenderer,
  migrateDefaults,
  checkInstallationUpdates,
  isEffectivelyEmptyInstallDir,
  UPDATE_CHECK_INTERVAL
} from './shared'
import { R2_BASE_URL } from '../r2Mirror'
import * as releaseCache from '../release-cache'
import type { RegisterCallbacks } from './shared'
import { registerAppHandlers } from './registerAppHandlers'
import { registerInstallationHandlers } from './registerInstallationHandlers'
import { registerSnapshotHandlers } from './registerSnapshotHandlers'
import { registerSettingsHandlers } from './registerSettingsHandlers'
import { registerSessionHandlers } from './registerSessionHandlers'
import { registerTerminalHandlers } from './registerTerminalHandlers'
import { registerLogsHandlers } from './registerLogsHandlers'
import { registerCrashHandlers } from './registerCrashHandlers'
import { registerTelemetryHandlers } from './registerTelemetryHandlers'

export {
  getAppVersion,
  stopRunning,
  hasRunningSessions,
  getSessionProcess,
  hasActiveOperations,
  getActiveDetails,
  cancelAll
} from './shared'
export type { RegisterCallbacks, ExitCallbackInfo } from './shared'

// Idempotent guard so a re-run (tests/hot-reload) doesn't double-subscribe.
let _releaseCacheBridgeWired = false
function wireReleaseCacheBroadcast(): void {
  if (_releaseCacheBridgeWired) return
  _releaseCacheBridgeWired = true
  releaseCache.onEnriched((repo) => {
    _broadcastToRenderer('release-cache-enriched', { repo })
  })
}

export function register(callbacks: RegisterCallbacks = {}): void {
  setCallbacks(callbacks)
  wireReleaseCacheBroadcast()

  installations.seedDefaults([
    {
      name: installations.CLOUD_INSTALL_NAME,
      sourceId: installations.CLOUD_SOURCE_ID,
      remoteUrl: 'https://cloud.comfy.org/',
      launchMode: 'window',
      browserPartition: 'shared'
    }
  ])
  installations.ensureExists(installations.CLOUD_SOURCE_ID, {
    name: installations.CLOUD_INSTALL_NAME,
    sourceId: installations.CLOUD_SOURCE_ID,
    remoteUrl: 'https://cloud.comfy.org/',
    launchMode: 'window',
    browserPartition: 'shared',
    status: 'installed'
  })
  // The Cloud entry is not user-renamable; reset any entry a prior build
  // let the user rename back to the canonical name (issue #922). Runs after
  // ensureExists via the shared FIFO write queue.
  void installations.enforceCloudName()

  // Auto-track a detected Legacy Desktop install.
  {
    const desktopInfo = detectDesktopInstall()
    if (desktopInfo) {
      installations.ensureExists('desktop', {
        name: 'ComfyUI Legacy Desktop',
        sourceId: 'desktop',
        installPath: desktopInfo.basePath,
        launchMode: 'external',
        desktopExePath: desktopInfo.executablePath || undefined,
        status: 'installed'
      })
    }
  }

  migrateDefaults()

  // Sweep empty/broken local installations on startup.
  void (async () => {
    try {
      const all = await installations.list()
      let swept = false
      for (const inst of all) {
        const source = sourceMap[inst.sourceId]
        if (!source || source.skipInstall) continue
        if (!inst.installPath) continue
        if (!isEffectivelyEmptyInstallDir(inst.installPath)) continue
        try {
          fs.rmSync(inst.installPath, { recursive: true, force: true })
        } catch {}
        await installations.remove(inst.id)
        swept = true
      }

      if (swept) _broadcastToRenderer('installations-changed', {})
    } catch {}
  })()

  // Default to bundled bootstrap pygit2 so the pygit2 path is always exercised
  // (system git would otherwise mask bugs real users hit). Falls back to
  // standalone pygit2 then system git; COMFY_FORCE_BOOTSTRAP_GIT=1 disables that.
  void (async () => {
    const configureGitBackend = async (): Promise<void> => {
      const forceBootstrap = process.env.COMFY_FORCE_BOOTSTRAP_GIT === '1'

      if (await tryConfigureBootstrapPygit2()) {
        console.log('[ipc] Using bootstrap pygit2 for git operations (default)')
        return
      }

      console.warn(
        '[ipc] Bootstrap pygit2 not available — bootstrap-python/<platform>/ is missing. ' +
          'Run "pnpm run bootstrap" (or "pnpm run bootstrap:fetch") to build it. ' +
          'Falling back to standalone-install pygit2 / system git.'
      )

      if (forceBootstrap) {
        console.warn(
          '[ipc] COMFY_FORCE_BOOTSTRAP_GIT set but bootstrap python not found — no git backend will be configured'
        )
        return
      }

      // Isolated try/catch so a listing failure doesn't skip the system-git fallback.
      try {
        const all = await installations.list()
        for (const inst of all) {
          if (inst.sourceId !== 'standalone' || !inst.installPath) continue
          if (await tryConfigurePygit2Fallback(inst.installPath)) {
            console.log(
              '[ipc] Configured pygit2 fallback via standalone install at',
              inst.installPath
            )
            return
          }
        }
      } catch (err) {
        console.warn('[ipc] Failed to enumerate standalone installations for pygit2 fallback:', err)
      }

      // Final fallback: system git, if installed.
      try {
        if (await isGitAvailable()) {
          console.log(
            '[ipc] Using system git (bootstrap pygit2 and standalone pygit2 both unavailable)'
          )
          return
        }
      } catch (err) {
        console.warn('[ipc] isGitAvailable() check failed:', err)
      }

      console.warn(
        '[ipc] No git backend available (bootstrap pygit2, standalone pygit2, and system git all missing)'
      )
    }

    await configureGitBackend()

    // Pre-warm the latest stable tag so the New Install wizard shows the
    // concrete version on first open (no local clone needed).
    try {
      await getLatestStableTag()
    } catch {}
  })()

  // Clean up partial downloads
  void (async () => {
    try {
      const cache = createCache(
        settings.get('cacheDir') as string,
        settings.get('maxCachedDownloads') as number
      )
      await cache.cleanPartials()
    } catch {}
  })()

  // Pre-warm the ETag cache
  void (async () => {
    try {
      await fetchJSON(`${R2_BASE_URL}/latest.json`)
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
  registerTerminalHandlers()
  registerLogsHandlers()
  registerCrashHandlers()
  registerTelemetryHandlers()
}
