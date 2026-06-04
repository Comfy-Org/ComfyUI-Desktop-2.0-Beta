// Primary host for the standalone Python bundles + their JSON manifests.
// Backed by Cloudflare R2. Unreachable from regions where R2's edge is
// throttled, so we maintain a parallel public mirror with the same content
// layout and fall back to it when the primary connection-resets.
export const R2_BASE_URL = 'https://desktop-assets.comfy.org/standalone-environments'

// Public GCS bucket (region: asia-east2) that mirrors R2 1:1 under the same
// /standalone-environments/ prefix. Kept in sync at each release.
export const R2_MIRROR_BASE_URL =
  'https://storage.googleapis.com/comfy-desktop-public/standalone-environments'

// Returns the mirror URL for a primary R2 URL, or undefined when the URL is
// outside the R2 namespace or no mirror is configured.
export function r2MirrorUrl(primaryUrl: string): string | undefined {
  if (!R2_MIRROR_BASE_URL) return undefined
  if (!primaryUrl.startsWith(R2_BASE_URL)) return undefined
  return R2_MIRROR_BASE_URL + primaryUrl.slice(R2_BASE_URL.length)
}
