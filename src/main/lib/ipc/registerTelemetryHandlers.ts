/**
 * IPC handlers for renderer-originated telemetry events.
 *
 * Part of the SDK consolidation: the renderer no longer talks to
 * PostHog directly. It calls `window.api.captureTelemetry(...)` which fires
 * `ipcRenderer.send('telemetry:*')`. Main routes the call through
 * `mainTelemetry.*` so identity (one `distinctId`), consent (one gate), and
 * dedup all live in one place.
 *
 * All three messages are fire-and-forget (`ipcMain.on`, not `handle`) — the
 * renderer does not await delivery, matching the previous direct-SDK ergonomics.
 *
 * Note on the `from-main` direction: events that ORIGINATE in main and need
 * to fan out to renderer-side Datadog RUM still use the existing
 * `telemetry-action-from-main` IPC + relay-target registry (see
 * `telemetry.forwardToRenderer`). That path is unchanged here.
 */
import { ipcMain } from 'electron'
import * as mainTelemetry from '../telemetry'
import {
  getFlag as getExperimentFlag,
  recordExposure,
  type ExperimentExposureSource
} from '../experiments'

interface CapturePayload {
  event?: unknown
  properties?: unknown
}

interface CaptureExceptionPayload {
  message?: unknown
  stack?: unknown
  properties?: unknown
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asProps(value: unknown): Record<string, mainTelemetry.TelemetryValue> {
  if (!value || typeof value !== 'object') return {}
  // Trust the renderer's `TelemetryContext` shape; main's `capture` does the
  // PostHog Node validation downstream.
  return value as Record<string, mainTelemetry.TelemetryValue>
}

export function registerTelemetryHandlers(): void {
  ipcMain.on('telemetry:capture', (_event, payload: CapturePayload) => {
    const eventName = asString(payload?.event)
    if (!eventName) return
    mainTelemetry.capture(eventName, asProps(payload.properties))
  })

  ipcMain.on('telemetry:captureException', (_event, payload: CaptureExceptionPayload) => {
    const message = asString(payload?.message) ?? 'Unknown renderer error'
    const stackStr = asString(payload?.stack) ?? undefined
    const err = new Error(message)
    if (stackStr) err.stack = stackStr
    mainTelemetry.captureException(err, asProps(payload?.properties))
  })

  ipcMain.on('telemetry:registerProperties', (_event, properties: unknown) => {
    const props = asProps(properties)
    if (Object.keys(props).length === 0) return
    // Person-property update: re-identify with $set semantics. mainTelemetry's
    // identify() takes a distinctId argument; we ride on the existing bound id.
    // If distinctId hasn't been bound yet (early renderer call before main's
    // boot identify), the call inside mainTelemetry.identify becomes a no-op
    // beyond caching props for deferred flush — acceptable.
    mainTelemetry.registerPersonProperties(props)
  })

  /**
   * Identity lifecycle (auth landing). The renderer's auth UI calls this
   * when a login succeeds; main aliases the anonymous installation_id into
   * the new user_id, sets `is_authenticated: true`, and fires
   * `app:user_logged_in`. See the telemetry design docs
   *
   * Renderer is still responsible for `datadogRum.setUser({ id })` on its
   * own SDK side — Datadog is browser-only.
   */
  ipcMain.on('telemetry:bindUserId', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const userId = asString((payload as Record<string, unknown>).userId)
    if (!userId) return
    const properties = asProps((payload as Record<string, unknown>).properties)
    mainTelemetry.bindUserId(userId, properties)
  })

  /**
   * Logout: switch distinct_id back to the anonymous installation_id.
   * NOT `posthog.reset()` (which would clobber installation_id and
   * download_token). See the telemetry design docs corrected.
   */
  ipcMain.on('telemetry:unbindUserId', () => {
    mainTelemetry.unbindUserId()
  })

  /**
   * Cache-first synchronous flag lookup for renderer A/B branches.
   * Returns the cached value or `null` if the flag is not present (caller
   * defaults to the control branch on `null`). See `experiments.ts` for
   * the cache lifecycle.
   */
  ipcMain.handle('telemetry:getExperimentFlag', (_event, key: unknown) => {
    const flagKey = asString(key)
    if (!flagKey) return null
    const value = getExperimentFlag(flagKey)
    return value === undefined ? null : value
  })

  /**
   * Renderer-driven exposure event. Per-session dedup is enforced
   * main-side so multiple renderer subscribers can call this safely.
   */
  ipcMain.on('telemetry:recordExposure', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const p = payload as Record<string, unknown>
    const experimentKey = asString(p.experimentKey)
    const variant = asString(p.variant)
    const sourceStr = asString(p.source)
    if (!experimentKey || !variant) return
    const source: ExperimentExposureSource =
      sourceStr === 'remote' ? 'remote' : sourceStr === 'fallback' ? 'fallback' : 'cache'
    recordExposure(experimentKey, variant, source)
  })
}
