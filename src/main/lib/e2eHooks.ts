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
import { _test_getOpenTitlePopupBounds } from '../popups/titlePopup'
import {
  installUpdateOverrides,
  INSTALL_UPDATE_GLOBAL_KEY,
} from './e2eOverrides'

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
  }
  ;(globalThis as unknown as { __e2e: E2EHelpers }).__e2e = helpers
}
