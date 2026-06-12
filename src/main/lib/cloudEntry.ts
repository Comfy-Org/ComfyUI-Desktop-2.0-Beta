/**
 * Cloud-entry telemetry tap.
 *
 * Fires `comfy.desktop.cloud.entered` the first time a cloud install's page
 * reaches dom-ready in a given app session. Gives the acquisition funnel a
 * clean `first_use.fork_chosen → cloud.entered` join point without depending
 * on the renderer's cohort-context register pass.
 *
 * Two guards:
 *   - Session dedup (module-level flag): the cloud page's `dom-ready` fires
 *     on every reload / re-attach, so the event would otherwise repeat many
 *     times per session.
 *   - First-ever marker (`cloud-entered-completed` guard file in `configDir`,
 *     mirroring the identity-migration guard): drives the `first_time`
 *     property. `true` only on the launch where the marker did not yet exist;
 *     also written as the `has_launched_cloud` person property so cohort
 *     filters agree with the event.
 */
import path from 'path'
import fs from 'fs'
import * as telemetry from './telemetry'
import { configDir } from './paths'

let enteredThisSession = false

function cloudEnteredGuardPath(): string {
  return path.join(configDir(), 'cloud-entered-completed')
}

function hasEnteredCloudBefore(): boolean {
  try {
    return fs.existsSync(cloudEnteredGuardPath())
  } catch {
    return false
  }
}

function markCloudEntered(): void {
  try {
    fs.mkdirSync(path.dirname(cloudEnteredGuardPath()), { recursive: true })
    fs.writeFileSync(cloudEnteredGuardPath(), new Date().toISOString())
  } catch {
    // best-effort persist; a failed write just means `first_time` may read
    // true again on a later launch, which over-counts rather than loses data.
  }
}

/**
 * Emit `comfy.desktop.cloud.entered` once per app session. `first_time` is
 * true only on the first-ever cloud entry across the installation's lifetime.
 * Subsequent calls within the same session no-op.
 */
export function noteCloudEntered(): void {
  if (enteredThisSession) return
  enteredThisSession = true
  const firstTime = !hasEnteredCloudBefore()
  if (firstTime) {
    markCloudEntered()
    telemetry.registerPersonProperties({ has_launched_cloud: true })
  }
  telemetry.emit('comfy.desktop.cloud.entered', { first_time: firstTime })
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  enteredThisSession = false
}
