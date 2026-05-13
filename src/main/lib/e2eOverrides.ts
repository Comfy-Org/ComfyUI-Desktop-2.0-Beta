/**
 * In-memory overrides used only by the E2E suite to bypass production
 * data paths (real GitHub release fetches, real auto-updater, real
 * downloads). Empty in production — the helpers in `e2eHooks.ts` are
 * only registered when `process.env['E2E'] === '1'`.
 *
 * Lives in its own module so production code (e.g. the
 * `computeInstallUpdateAvailable` in `index.ts`) can consult the map
 * with a single `.get()` call without pulling in the rest of the E2E
 * scaffolding.
 */

/** Sentinel key for "apply this override to every installationId". */
export const INSTALL_UPDATE_GLOBAL_KEY = '*'

export interface InstallUpdateOverride {
  available: boolean
  version?: string
}

export const installUpdateOverrides = new Map<string, InstallUpdateOverride>()

export function lookupInstallUpdateOverride(installationId: string): InstallUpdateOverride | undefined {
  return installUpdateOverrides.get(installationId) ?? installUpdateOverrides.get(INSTALL_UPDATE_GLOBAL_KEY)
}
