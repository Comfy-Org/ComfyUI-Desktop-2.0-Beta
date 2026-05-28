/**
 * URL discriminators for the Firebase auth-handler popup that the
 * cloud frontend's `signInWithPopup(...)` opens via `window.open()`.
 * We deny these popups at `setWindowOpenHandler` time and reroute the
 * sign-in through the user's system browser via the loopback bridge.
 *
 * Both prod (`dreamboothy`) and dev (`dreamboothy-dev`) Firebase
 * projects are matched. The cloud frontend chooses which based on
 * its build-time flag + a runtime remote-config override; we match
 * both and let the bridge mirror whichever project the URL points at.
 */
const FIREBASE_AUTH_HANDLER_HOSTS = [
  'dreamboothy.firebaseapp.com',
  'dreamboothy-dev.firebaseapp.com',
] as const

const FIREBASE_AUTH_HANDLER_PATH = '/__/auth/handler'

export function isFirebaseAuthHandlerUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (!FIREBASE_AUTH_HANDLER_HOSTS.includes(parsed.host as (typeof FIREBASE_AUTH_HANDLER_HOSTS)[number])) {
    return false
  }
  return parsed.pathname === FIREBASE_AUTH_HANDLER_PATH
}

/**
 * `signInWithPopup` encodes the OAuth provider in the `providerId`
 * query param of the auth-handler URL (e.g. `providerId=google.com`).
 * The bridge needs this to construct the matching Firebase provider
 * before `signInWithRedirect`.
 *
 * Returns `null` when the URL has no providerId or an unsupported one
 * — callers should fall back to the existing popup behaviour.
 */
export type SupportedProvider = 'google.com' | 'github.com'

export function extractProviderId(url: string): SupportedProvider | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const providerId = parsed.searchParams.get('providerId')
  if (providerId === 'google.com' || providerId === 'github.com') {
    return providerId
  }
  return null
}
