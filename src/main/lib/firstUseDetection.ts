// First-use takeover detection. Computes two signals for the renderer's
// stepper: `skipPick` (any install beyond the always-present Cloud and
// optional auto-tracked Legacy Desktop → user has used the launcher, skip the
// cloud-vs-local fork) and `hasLegacyDesktop` (auto-tracked legacy install
// present → gate the Migrate-vs-Install-new sub-step).
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
    // Any other source counts as prior launcher usage.
    skipPick = true
  }
  return { skipPick, hasLegacyDesktop }
}
