// IPC for renderer-originated telemetry: the renderer routes through main so
// identity, consent, and dedup live in one place. Capture messages are
// fire-and-forget (ipcMain.on).
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

function isTelemetryValue(v: unknown): v is mainTelemetry.TelemetryValue {
  return (
    v === null ||
    v === undefined ||
    typeof v === 'boolean' ||
    typeof v === 'number' ||
    typeof v === 'string'
  )
}

// Per-key filter to the TelemetryValue contract; renderer payloads cross a
// trust boundary, so non-primitives (incl. arrays) are dropped per-key.
function asProps(value: unknown): Record<string, mainTelemetry.TelemetryValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, mainTelemetry.TelemetryValue> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string') continue
    if (isTelemetryValue(raw)) {
      out[key] = raw
    }
    // Drop anything else (objects, arrays, functions, symbols, etc.) silently.
  }
  return out
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
    mainTelemetry.registerPersonProperties(props)
  })

  // On login: alias the anonymous installation_id into the user_id. Renderer
  // still owns datadogRum.setUser (Datadog is browser-only).
  ipcMain.on('telemetry:bindUserId', (_event, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const userId = asString((payload as Record<string, unknown>).userId)
    if (!userId) return
    const properties = asProps((payload as Record<string, unknown>).properties)
    mainTelemetry.bindUserId(userId, properties)
  })

  // Logout: switch distinct_id back to the anonymous installation_id (NOT
  // posthog.reset(), which would clobber installation_id + download_token).
  ipcMain.on('telemetry:unbindUserId', () => {
    mainTelemetry.unbindUserId()
  })

  // Cache-first flag lookup for renderer A/B branches; null → control.
  ipcMain.handle('telemetry:getExperimentFlag', (_event, key: unknown) => {
    const flagKey = asString(key)
    if (!flagKey) return null
    const value = getExperimentFlag(flagKey)
    return value === undefined ? null : value
  })

  // Exposure event; per-session dedup is enforced main-side.
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
