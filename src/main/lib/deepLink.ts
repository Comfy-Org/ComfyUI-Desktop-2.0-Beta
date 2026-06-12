/**
 * `comfy://` deep-link resolution.
 *
 * The OS hands us an arbitrary string when a `comfy://` link is opened.
 * This module turns it into a fully-qualified cloud URL, or `null` when
 * the input is anything we don't explicitly trust. It is deliberately
 * pure (no Electron, no I/O) so the allowlist can be exhaustively
 * unit-tested — the security of the feature lives here.
 *
 * Supported shapes:
 *   comfy://open?path=/workflows/123      → https://cloud.comfy.org/workflows/123
 *   comfy://open?url=https://cloud.comfy.org/x → https://cloud.comfy.org/x
 *
 * Security model: the resolved URL's origin MUST be in CLOUD_ALLOWLIST.
 * Anything that resolves to another origin or scheme — including
 * protocol-relative `//evil.com` tricks smuggled through `path` — returns
 * `null`. We never return a non-cloud URL.
 */

/** The only origins a deep link is allowed to navigate to. */
const CLOUD_ALLOWLIST = ['https://cloud.comfy.org'] as const

/** Canonical cloud origin used to resolve `path=` links. */
const CLOUD_ORIGIN = CLOUD_ALLOWLIST[0]

/** The single scheme we register and accept. */
const DEEP_LINK_SCHEME = 'comfy:'

function isAllowedOrigin(origin: string): boolean {
  return (CLOUD_ALLOWLIST as readonly string[]).includes(origin)
}

/**
 * Resolve a raw `comfy://` deep link to a cloud URL, or `null` if the
 * input is not a trusted cloud link.
 */
export function resolveDeepLink(rawUrl: string): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null

  let link: URL
  try {
    link = new URL(rawUrl)
  } catch {
    return null
  }

  // Only our own scheme. Rejects http:, https:, file:, javascript:, etc.
  if (link.protocol !== DEEP_LINK_SCHEME) return null

  // Path-based: comfy://open?path=/some/path
  const pathParam = link.searchParams.get('path')
  // Full-URL-based: comfy://open?url=<https url on an allowed origin>
  const urlParam = link.searchParams.get('url')

  let candidate: string | null = null

  if (urlParam) {
    candidate = resolveUrlParam(urlParam)
  } else if (pathParam) {
    candidate = resolvePathParam(pathParam)
  }

  if (!candidate) return null

  // Final belt-and-braces check: re-parse and re-validate the origin so a
  // bug in either resolver can never leak a non-cloud URL.
  let resolved: URL
  try {
    resolved = new URL(candidate)
  } catch {
    return null
  }
  if (!isAllowedOrigin(resolved.origin)) return null

  return resolved.href
}

/** Resolve a `url=` param: must already be an absolute URL on an allowed origin. */
function resolveUrlParam(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (!isAllowedOrigin(parsed.origin)) return null
  return parsed.href
}

/**
 * Resolve a `path=` param against the canonical cloud origin.
 *
 * Must be a server-absolute path (`/...`). Rejects:
 *  - protocol-relative `//evil.com` (would change origin)
 *  - absolute URLs smuggled in (`https://evil.com`, `comfy://...`)
 *  - relative paths (`workflows/123`)
 * by requiring a leading single slash and confirming the resolved origin
 * is unchanged after joining.
 */
function resolvePathParam(value: string): string | null {
  // Must start with a single `/` and not a second `/` (protocol-relative).
  if (!value.startsWith('/') || value.startsWith('//')) return null
  // A backslash can be normalised to `/` by some parsers — reject leading
  // ones so `/\evil.com` style tricks can't sneak through.
  if (value.includes('\\')) return null

  let joined: URL
  try {
    joined = new URL(value, CLOUD_ORIGIN + '/')
  } catch {
    return null
  }
  // Joining a true server-absolute path must not change the origin.
  if (joined.origin !== CLOUD_ORIGIN) return null
  return joined.href
}
