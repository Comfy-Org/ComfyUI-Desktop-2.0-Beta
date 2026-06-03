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
import * as releaseCache from '../release-cache'
import type { RegisterCallbacks } from './shared'
import { registerAppHandlers } from './registerAppHandlers'
import { registerInstallationHandlers } from './registerInstallationHandlers'
import { registerSnapshotHandlers } from './registerSnapshotHandlers'
import { registerSettingsHandlers } from './registerSettingsHandlers'
import { registerSessionHandlers } from './registerSessionHandlers'
import { registerCrashHandlers } from './registerCrashHandlers'
import { registerTelemetryHandlers } from './registerTelemetryHandlers'

// Re-export public API from shared
export {
  getAppVersion,
  stopRunning,
  hasRunningSessions,
  getSessionProcess,
  hasActiveOperations,
  getActiveDetails,
  cancelAll
} from './shared'
export type { RegisterCallbacks } from './shared'

/** Idempotent bridge between `releaseCache.onEnriched` (a module-level
 *  event) and `_broadcastToRenderer`. `register()` is called once per
 *  app boot in production, but tests and hot-reload paths can invoke it
 *  again — without this guard we'd subscribe twice and every enrichment
 *  would broadcast twice. */
let _releaseCacheBridgeWired = false
function wireReleaseCacheBroadcast(): void {
  if (_releaseCacheBridgeWired) return
  _releaseCacheBridgeWired = true
  // Fires only when `enrichCommitsAhead` actually writes a new
  // `commitsAhead` value, so open panels can refresh affected sections
  // in place (e.g. the Update tab's "Latest from GitHub" card switches
  // from `tag (sha)` to `tag + N commits (sha)` once enrichment lands
  // in the background).
  releaseCache.onEnriched((repo) => {
    _broadcastToRenderer('release-cache-enriched', { repo })
  })
}

export function register(callbacks: RegisterCallbacks = {}): void {
  setCallbacks(callbacks)
  wireReleaseCacheBroadcast()

  installations.seedDefaults([
    {
      name: 'Comfy Cloud',
      sourceId: 'cloud',
      remoteUrl: 'https://cloud.comfy.org/',
      launchMode: 'window',
      browserPartition: 'shared'
    }
  ])
  installations.ensureExists('cloud', {
    name: 'Comfy Cloud',
    sourceId: 'cloud',
    remoteUrl: 'https://cloud.comfy.org/',
    launchMode: 'window',
    browserPartition: 'shared',
    status: 'installed'
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

  // Configure git backend.  We default to the bundled bootstrap pygit2 so the
  // pygit2 code path is always exercised — most developers have system git
  // installed, which would otherwise mask bugs in the pygit2 path that real
  // users (without system git) hit on first launch.
  //
  // If bootstrap pygit2 is unavailable for any reason we log loudly and fall
  // back to standalone-install pygit2, then system git.  Set
  // COMFY_FORCE_BOOTSTRAP_GIT=1 to disable the fallback entirely (for testing).
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

      // Prefer standalone installation's pygit2 (co-located with ComfyUI env).
      // Failures listing installations must NOT short-circuit the system-git
      // fallback below, so this lookup is isolated in its own try/catch.
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

    // Pre-warm the latest stable tag cache.  Once a git backend is configured
    // (bootstrap pygit2 / standalone pygit2 / system git) we can resolve the
    // upstream ComfyUI tag without any local clone — this makes the New
    // Install wizard's "Latest Stable" entry display the concrete version
    // (e.g. v1.19.5) on first open.
    try {
      await getLatestStableTag()
    } catch {}
  })()

  // Clean up partial downloads
  void (async () => {
    try {
      const cache = createCache(
        settings.get('cacheDir') as string,
        settings.get('maxCachedFiles') as number
      )
      await cache.cleanPartials()
    } catch {}
  })()

  // Pre-warm the ETag cache
  void (async () => {
    try {
      await fetchJSON('https://desktop-assets.comfy.org/standalone-environments/latest.json')
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
  registerCrashHandlers()
  registerTelemetryHandlers()
}
