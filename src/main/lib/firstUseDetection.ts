/**
 * First-use takeover detection — categorises the persisted installs
 * into the two signals the renderer's FirstUseTakeover stepper needs.
 *
 * Routed through the `get-first-use-state` IPC handler in
 * `registerSettingsHandlers`. Owned by main because the source-id
 * categorisation matches the source-plugin invariants (Cloud is
 * always-present via `installations.ensureExists`, Legacy Desktop
 * gets auto-tracked at startup if `detectDesktopInstall()` finds an
 * install) — the renderer would have to duplicate those rules to
 * derive the same answer from the installation store.
 *
 *  - `skipPick` is true when ANY install exists beyond the always-
 *    present Cloud entry and the optional auto-tracked Legacy
 *    Desktop entry. The user has clearly used the launcher before so
 *    the cloud-vs-local fork is suppressed; the takeover stops at
 *    the consent step (and the optional China-mirror sub-step) and
 *    emits `complete` instead of advancing to `pick`.
 *
 *  - `hasLegacyDesktop` is true when the auto-tracked Legacy Desktop
 *    install (`sourceId === 'desktop'`) is present. The renderer
 *    uses it to gate the Migrate-vs-Install-new sub-step that runs
 *    after the user picks Local — when no legacy desktop is detected,
 *    Local pick goes straight into the new-install Standalone chain.
 */
import * as installations from '../installations'

export interface FirstUseDetection {
  skipPick: boolean
  hasLegacyDesktop: boolean
}

export async function detectFirstUseState(): Promise<FirstUseDetection> {
  const all = await installations.list()
  let skipPick = false
  let hasLegacyDesktop = false
  for (const inst of all) {
    if (inst.sourceId === 'desktop') {
      hasLegacyDesktop = true
      continue
    }
    if (inst.sourceId === 'cloud') continue
    // Anything else — standalone / portable / git / remote — counts as
    // prior usage of the launcher.
    skipPick = true
  }
  return { skipPick, hasLegacyDesktop }
}
