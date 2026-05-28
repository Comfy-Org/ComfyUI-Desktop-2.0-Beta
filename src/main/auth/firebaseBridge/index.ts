import { shell, type BrowserWindow, type WebContents } from 'electron'

import { detectFirebaseEnv } from './config'
import { buildIndexedDbInjectScript } from './inject'
import { extractProviderId, type SupportedProvider } from './intercept'
import { startBridgeServer } from './server'
import * as mainTelemetry from '../../lib/telemetry'

/**
 * Tie the anonymous `installation_id` to the signed-in user so PostHog
 * merges the two identities. Both auth paths (Google server-side,
 * GitHub popup) converge on the resolved Firebase `user` record, so this
 * is the single hook that covers every sign-in.
 *
 * Only the email DOMAIN is sent (never the raw address) — enough to
 * power internal cohort filters (e.g. the comfy.org A/B targeting)
 * without shipping PII. `bindUserId` is consent-gated downstream, so a
 * user who declined telemetry binds nothing. Wrapped so a telemetry
 * failure can never break the auth flow.
 */
function bindSignedInUser(user: Record<string, unknown>): void {
  try {
    const uid = typeof user.uid === 'string' && user.uid.length > 0 ? user.uid : null
    if (!uid) return
    const email = typeof user.email === 'string' ? user.email : null
    const at = email ? email.lastIndexOf('@') : -1
    const emailDomain = at >= 0 ? email!.slice(at + 1).toLowerCase() : null
    mainTelemetry.bindUserId(uid, emailDomain ? { email_domain: emailDomain } : {})
  } catch {
    // telemetry must never break the auth flow
  }
}

export { extractProviderId, isFirebaseAuthHandlerUrl } from './intercept'

export interface HandleFirebasePopupOpts {
  /**
   * Optional handle to the BrowserWindow that owns `comfyContents`.
   * When provided, we restore + focus it after the bridge completes so
   * the user returns to ComfyUI Desktop instead of staying parked on
   * the now-finished browser tab.
   */
  parentWindow?: BrowserWindow
  onError?: (err: Error) => void
}

/**
 * Orchestrate the system-browser sign-in for a Firebase auth-handler
 * URL that the embedded cloud-workspace view tried to open via
 * `window.open()`.
 *
 * Flow:
 *   1. Detect prod/dev project + IdP from the intercepted URL.
 *   2. Spin up a loopback HTTP server with a bridge page that runs
 *      `signInWithPopup` in the user's system browser (passkeys +
 *      saved-passwords + existing IdP sessions all work there).
 *   3. Await the bridge's `/callback` carrying `auth.currentUser.toJSON()`.
 *   4. Inject the serialized user into the embedded view's
 *      `firebaseLocalStorageDb` IndexedDB and reload — Firebase's SDK
 *      rehydrates from persistence on init, fires `onAuthStateChanged`,
 *      and the existing `/auth/session` post handles the rest.
 *   5. Focus the Desktop window so the user is yanked back into the
 *      app without needing to alt-tab from their browser.
 *
 * Errors are reported via the optional `onError` callback (the caller
 * forwards them to Datadog without taking down the embedded view).
 * On error we deliberately do NOT try to fall back to opening the
 * Firebase popup as an Electron window — the user has already lost
 * trust at that point, and silently restoring the old (passkey-less)
 * popup flow is more confusing than asking them to retry sign-in.
 */
/**
 * Singleton handle for the in-flight bridge. We bind to a fixed loopback
 * port (so the Google OAuth client's exact-match `redirect_uri`
 * allowlist works), which means only ONE bridge can run at a time. If
 * the user clicks Sign in while a previous attempt is still parked on
 * an open browser tab, we close the stale bridge (freeing the port)
 * before spinning up the new one.
 */
let activeBridge: Awaited<ReturnType<typeof startBridgeServer>> | null = null

/**
 * Time we hold on the "You're signed in" browser page before injecting
 * the user into the embedded view and pulling focus to Desktop. The
 * bridge HTML renders a synchronised countdown — keep these in lockstep.
 */
const POST_SIGNIN_HOLD_MS = 3000

export async function handleFirebasePopup(
  url: string,
  comfyContents: WebContents,
  opts: HandleFirebasePopupOpts = {}
): Promise<void> {
  const providerId = extractProviderId(url)
  if (!providerId) {
    opts.onError?.(new Error(`Firebase popup URL missing providerId: ${url}`))
    return
  }
  const env = detectFirebaseEnv(url)

  // Kill any stale bridge from a prior sign-in attempt the user
  // didn't complete. Without this, the second Sign-in click hits an
  // EADDRINUSE on the fixed loopback port and the user sees an
  // unhelpful auth/popup-blocked error from the embedded view (we
  // denied the popup but couldn't open the replacement bridge).
  if (activeBridge) {
    try {
      activeBridge.close()
    } catch {
      // best-effort
    }
    activeBridge = null
  }

  let handle: Awaited<ReturnType<typeof startBridgeServer>> | null = null
  try {
    handle = await startBridgeServer({ env, providerId })
    activeBridge = handle
    // Append a per-attempt nonce so browsers don't focus an existing
    // stale tab from a previous (perhaps wrong-provider) sign-in
    // attempt. macOS Chrome / Safari treat shell.openExternal of an
    // identical URL as "focus the open tab" rather than "open fresh"
    // — without the nonce the user would still see yesterday's GitHub
    // bridge page when they intended to start a new Google flow.
    void shell.openExternal(`${handle.url}?n=${Date.now().toString(36)}`)
    const { user, apiKey } = await handle.signInPromise
    // Bind PostHog identity as soon as we have the user — independent of
    // the embedded-view reload below, so the merge happens even if the
    // window is torn down before the reload completes.
    bindSignedInUser(user)
    if (comfyContents.isDestroyed()) return
    // Hold for a beat so the user actually sees the "You're signed in"
    // page (with its synchronised countdown) before we yank focus back
    // to Desktop and reload the embedded view. Without this the focus
    // grab happens essentially instantly after the OAuth callback
    // lands, which feels jarring — they barely see the bridge confirm
    // success before Desktop snatches focus.
    await new Promise<void>((resolve) => setTimeout(resolve, POST_SIGNIN_HOLD_MS))
    if (comfyContents.isDestroyed()) return
    await comfyContents.executeJavaScript(buildIndexedDbInjectScript(user, apiKey), true)
    // Pull the user back into the app. `show()` un-minimises on
    // platforms that need it; `focus()` lifts the OS-level focus from
    // the browser. Best-effort — a destroyed window is a no-op.
    const { parentWindow } = opts
    if (parentWindow && !parentWindow.isDestroyed()) {
      if (parentWindow.isMinimized()) parentWindow.restore()
      parentWindow.show()
      parentWindow.focus()
    }
  } catch (err) {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)))
  } finally {
    handle?.close()
    if (activeBridge === handle) activeBridge = null
  }
}

// Re-export the supported provider type for callers that need to
// narrow the union before passing to `handleFirebasePopup`.
export type { SupportedProvider }
