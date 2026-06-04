import { getDeviceId } from './deviceId'

const CLOUD_DISTRIBUTION_HOST = 'cloud.comfy.org'

const DEFAULT_UTM_PARAMS: Record<string, string> = {
  utm_source: 'comfy.desktop',
  utm_medium: 'app_feature'
}

// Query param used to forward the Desktop telemetry distinct_id into
// the cloud webContents so cloud.comfy.org's posthog-js can call
// `posthog.identify(...)` and stitch the two sessions. Until that
// cloud-side change ships, the param is harmless extra data on the URL
// — but every Desktop → Cloud event already carries it for the day the
// stitcher is wired up.
const DESKTOP_DEVICE_ID_PARAM = 'desktop_device_id'

function warnSkippedUtm(reason: string, details: Record<string, string>): void {
  console.warn(`[cloud-utm] ${reason}`, details)
}

export function withCloudDistributionUtm(
  rawUrl: string,
  // Injection point so unit tests can pin a value; production callers
  // omit this and let the helper read from the shared deviceId module.
  deviceIdProvider: () => string | null = getDeviceId
): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    warnSkippedUtm('Skipped UTM tagging because URL parsing failed', { rawUrl })
    return rawUrl
  }
  if (url.hostname.toLowerCase() !== CLOUD_DISTRIBUTION_HOST) {
    warnSkippedUtm('Skipped UTM tagging because host is not cloud.comfy.org', {
      host: url.hostname,
      rawUrl: url.href
    })
    return rawUrl
  }

  for (const [key, value] of Object.entries(DEFAULT_UTM_PARAMS)) {
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
  }

  // Append the Desktop device-id as a separate query param so cloud-side
  // posthog-js can identify() the user against the same distinct_id the
  // Desktop main process uses. Don't overwrite an explicit caller value
  // and skip when the id hasn't resolved yet (initDeviceId still in
  // flight) so we never ship an empty string.
  if (!url.searchParams.has(DESKTOP_DEVICE_ID_PARAM)) {
    const id = deviceIdProvider()
    if (id) {
      url.searchParams.set(DESKTOP_DEVICE_ID_PARAM, id)
    }
  }

  return url.href
}
