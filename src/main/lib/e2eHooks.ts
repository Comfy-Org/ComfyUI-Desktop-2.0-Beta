/**
 * Test-only helpers exposed on `globalThis.__e2e` so the Playwright
 * `app.evaluate(...)` bridge can drive main-side state without
 * round-tripping through the production data paths (real GitHub
 * release fetches, real auto-updater HTTP, real downloads).
 *
 * Only loaded + registered when `process.env['E2E'] === '1'` (see
 * `index.ts whenReady`). The implementations live in their owning
 * modules as `_test_*` exports — this module is the single
 * registration point so the surface is greppable as `__e2e:*`.
 *
 * Mirrored test-side by `e2e/support/devHooks.ts`, which exposes a
 * typed wrapper around each helper.
 */

import {
  _test_setSeededTrayState,
  type DownloadsTrayState,
} from './comfyDownloadManager'
import { _test_setUpdateState, type AppUpdateState } from './updater'
import {
  get as _releaseCacheGet,
  _test_ageEntries as _test_ageReleaseCacheEntries,
} from './release-cache'
import { _test_getOpenTitlePopupBounds } from '../popups/titlePopup'
import { returnToDashboard } from '../host/detach'
import { comfyWindows, isInstallHost } from '../host/registry'
import {
  installUpdateOverrides,
  INSTALL_UPDATE_GLOBAL_KEY,
  getIpcInvocations,
  resetIpcInvocations,
  getShellOpenExternalCalls,
  resetShellOpenExternalCalls,
} from './e2eOverrides'
import { _test_addRunningSession, _test_clearRunningSessions } from './ipc/shared'

interface SetInstallUpdateOpts {
  /** Omit to apply the override globally (matches every installationId). */
  installationId?: string
  available: boolean
  version?: string
}

export interface E2EHelpers {
  /** Replace the downloads tray (active + recent) with a snapshot and
   *  broadcast `tray-state-changed`. */
  seedDownloads(snapshot: DownloadsTrayState): void
  /** Stub the install-update probe for one (or all) installations. */
  setInstallUpdate(opts: SetInstallUpdateOpts): void
  /** Push an arbitrary `AppUpdateState` through the broadcast pipeline. */
  setAppUpdateState(state: AppUpdateState): void
  /** Read the bounds of the currently-open title-bar dropdown popup. */
  getTitlePopupBounds(): ReturnType<typeof _test_getOpenTitlePopupBounds>
  /** Trigger the File menu's "Return to Dashboard" action on the
   *  first install-backed host window — flips it in place to chooser
   *  mode without going through the popup. Resolves to the BrowserWindow
   *  id that was flipped (or null if no install-backed host exists). */
  returnFirstInstallHostToDashboard(): Promise<number | null>
  /** Read the list of recorded invocations for an instrumented IPC
   *  channel (e.g. `'get-detail-sections'`). Each entry is the first
   *  argument the handler received. */
  getIpcInvocations(channel: string): unknown[]
  /** Clear the recorded invocations for one channel, or all channels
   *  when called with no argument. Tests call this in `beforeAll` /
   *  `beforeEach` to assert against deltas rather than cumulative
   *  state across suites. */
  resetIpcInvocations(channel?: string): void
  /** URLs Electron's `shell.openExternal(...)` was called with via
   *  the launcher's wrapper. Empty unless the production code recorded
   *  an external open while `E2E === '1'`. */
  getShellOpenExternalCalls(): string[]
  /** Reset the captured `shell.openExternal` URL list. */
  resetShellOpenExternalCalls(): void
  /** Register a synthetic running session against `installationId`
   *  without spawning a real ComfyUI process. Main's REQUIRES_STOPPED
   *  guard sees the install as running; renderer `sessionStore.isRunning`
   *  flips true via the `instance-started` broadcast. */
  seedRunningSession(opts: { installationId: string; installationName: string }): void
  /** Drop every synthetic session registered via `seedRunningSession`. */
  clearRunningSessions(): void
  /** Read the `checkedAt` ms timestamp from the shared release cache
   *  entry for `(repo, channel)`. Returns `null` when no entry exists
   *  yet. Used by the periodic-poll lifecycle test to observe that the
   *  background timer ran a real second fetch. */
  getReleaseCacheCheckedAt(repo: string, channel: string): number | null
  /** Force every entry in the shared release cache to the given
   *  `checkedAt` timestamp so the renderer-side stale-cache watcher
   *  in `ComfyUISettingsContent` treats the data as stale and auto-
   *  fires `check-update` on the next picker open. */
  ageReleaseCache(maxCheckedAt: number): void
}

export function registerE2EHooks(): void {
  const helpers: E2EHelpers = {
    seedDownloads: _test_setSeededTrayState,
    setInstallUpdate(opts) {
      const key = opts.installationId ?? INSTALL_UPDATE_GLOBAL_KEY
      if (opts.available) {
        installUpdateOverrides.set(key, { available: true, version: opts.version })
      } else {
        installUpdateOverrides.delete(key)
      }
    },
    setAppUpdateState: _test_setUpdateState,
    getTitlePopupBounds: _test_getOpenTitlePopupBounds,
    async returnFirstInstallHostToDashboard() {
      for (const entry of comfyWindows.values()) {
        if (entry.window.isDestroyed() || !isInstallHost(entry)) continue
        const id = entry.window.id
        await returnToDashboard(entry.windowKey)
        return id
      }
      return null
    },
    getIpcInvocations,
    resetIpcInvocations,
    getShellOpenExternalCalls,
    resetShellOpenExternalCalls,
    seedRunningSession(opts) {
      _test_addRunningSession(opts.installationId, opts.installationName)
    },
    clearRunningSessions: _test_clearRunningSessions,
    getReleaseCacheCheckedAt(repo, channel) {
      return _releaseCacheGet(repo, channel)?.checkedAt ?? null
    },
    ageReleaseCache: _test_ageReleaseCacheEntries,
  }
  ;(globalThis as unknown as { __e2e: E2EHelpers }).__e2e = helpers
}
