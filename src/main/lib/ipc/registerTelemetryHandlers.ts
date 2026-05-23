/**
 * IPC handlers for renderer-originated telemetry events.
 *
 * Part of the Phase 1.3 SDK consolidation: the renderer no longer talks to
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
}
