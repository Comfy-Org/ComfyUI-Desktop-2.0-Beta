import { shell, type BrowserWindow, type WebContents } from 'electron'

import { detectFirebaseEnv } from './config'
import {
  buildCopyLinkBannerScript,
  buildRemoveCopyLinkBannerScript,
  COPY_LINK_BANNER_CSS,
  OPEN_LINK_SENTINEL,
} from './copyLinkBanner'
import { buildIndexedDbInjectScript } from './inject'
import { extractProviderId, type SupportedProvider } from './intercept'
import { startBridgeServer } from './server'
import * as i18n from '../../lib/i18n'
import * as mainTelemetry from '../../lib/telemetry'

/**
 * Tie the anonymous `installation_id` to the signed-in user so PostHog
 * merges the two identities. Both auth paths (Google server-side,
 * GitHub popup) converge on the resolved Firebase `user` record, so this
 * is the single hook that covers every sign-in.
 *
 * Person properties shipped:
 *   - `email` — raw address. Industry-standard for product analytics
 *     and the only practical way to support "what did <person> do"
 *     lookups for support / debugging without a two-system round-trip
 *     through Firebase Admin. PostHog's `$email` field also lights up
 *     the person card with an avatar + email so persons-view search
 *     by email works as expected.
 *   - `email_domain` — cohort filter (e.g. comfy.org A/B targeting).
 *     Kept alongside the raw email so existing filters / experiments
 *     don't have to derive it at query time.
 *   - `signed_in_via: 'desktop_2'` — every event from this person from
 *     here on inherits this, so cloud-side events (when the user later
 *     interacts with the embedded cloud workspace) are attributable to
 *     a desktop-originated sign-in. Covers the case where the OAuth
 *     flow itself runs in the system browser (no cloud.comfy.org
 *     pageview during auth, so utm_source alone can't carry it).
 *   - `signed_in_at_ms` — epoch-ms of the most recent sign-in. Useful
 *     for "users who signed in within the last N days" cohorts.
 *
 * `bindUserId` is consent-gated downstream — a user who declined
 * telemetry binds nothing. Wrapped so a telemetry failure can never
 * break the auth flow.
 */
function bindSignedInUser(user: Record<string, unknown>): void {
  try {
    const uid = typeof user.uid === 'string' && user.uid.length > 0 ? user.uid : null
    if (!uid) return
    const email = typeof user.email === 'string' && user.email.length > 0 ? user.email : null
    const at = email ? email.lastIndexOf('@') : -1
    const emailDomain = at >= 0 ? email!.slice(at + 1).toLowerCase() : null
    const properties: Record<string, string | number> = {
      signed_in_via: 'desktop_2',
      signed_in_at_ms: Date.now()
    }
    if (email) properties.email = email
    if (emailDomain) properties.email_domain = emailDomain
    mainTelemetry.bindUserId(uid, properties)
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
 * Teardown for the in-flight "copy login link" card: removes the injected
 * DOM node and detaches the `console-message` listener bound to it. Held
 * at module scope (like `activeBridge`) so a fresh sign-in attempt can
 * clear a prior attempt's card before showing its own.
 */
let activeBannerCleanup: (() => void) | null = null

/** Run + clear the in-flight card teardown, if any. Safe to call twice. */
function runBannerCleanup(): void {
  const cleanup = activeBannerCleanup
  activeBannerCleanup = null
  cleanup?.()
}

/**
 * Inject the "we opened your browser" card into the Cloud view. Same
 * `loginUrl` we just opened, so the copied link matches the open tab.
 * Copy stays in-page; only "Open again" reaches main, via a top-frame
 * `OPEN_LINK_SENTINEL` console message that re-opens our own URL.
 */
function showCopyLinkBanner(comfyContents: WebContents, loginUrl: string): void {
  if (comfyContents.isDestroyed()) return

  const labels = {
    message: i18n.t('cloud.signInBanner.message'),
    copy: i18n.t('cloud.signInBanner.copy'),
    copied: i18n.t('cloud.signInBanner.copied'),
    openAgain: i18n.t('cloud.signInBanner.openAgain'),
    dismiss: i18n.t('cloud.signInBanner.dismiss'),
  }

  void comfyContents
    .insertCSS(COPY_LINK_BANNER_CSS)
    .then(() => comfyContents.executeJavaScript(buildCopyLinkBannerScript(loginUrl, labels), true))
    .catch(() => { })

  const onConsoleMessage = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    // Top-frame only: ignore the sentinel if an iframe logs it.
    if (details.frame?.parent != null) return
    if (details.message !== OPEN_LINK_SENTINEL) return
    void shell.openExternal(loginUrl).catch(() => { })
  }
  comfyContents.on('console-message', onConsoleMessage)

  activeBannerCleanup = () => {
    comfyContents.off('console-message', onConsoleMessage)
    if (!comfyContents.isDestroyed()) {
      void comfyContents.executeJavaScript(buildRemoveCopyLinkBannerScript(), true).catch(() => { })
    }
  }
}

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
  // Sign-in funnel: started -> (app:user_logged_in | auth.sign_in_failed).
  // `provider` splits Google vs GitHub conversion + failure rates. The
  // success leg is emitted by bindSignedInUser's app:user_logged_in.
  mainTelemetry.capture('desktop2.auth.sign_in_started', { provider: providerId })
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
  // Clear a prior attempt's "copy link" card + its console listener so a
  // new attempt doesn't stack a second card or leak a stale listener.
  runBannerCleanup()

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
    // Capture the full nonce'd URL once so the auto-opened tab, the
    // "Copy link" button, and "Open again" all hand out the same link.
    const loginUrl = `${handle.url}?n=${Date.now().toString(36)}`
    void shell.openExternal(loginUrl)
    // Surface a Notion/Claude-style "didn't open? copy the link" card in
    // the Cloud view so users can finish sign-in in a non-default browser.
    showCopyLinkBanner(comfyContents, loginUrl)
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
    const error = err instanceof Error ? err : new Error(String(err))
    // Mirrored to Datadog (allow-list) so ops can alert if sign-in
    // breaks for a provider. error_bucket keeps the dashboard low-
    // cardinality; the raw message stays out (may carry tokens / URLs).
    mainTelemetry.emit('desktop2.auth.sign_in_failed', {
      provider: providerId,
      error_bucket: mainTelemetry.bucketError(error.message)
    })
    opts.onError?.(error)
  } finally {
    handle?.close()
    if (activeBridge === handle) activeBridge = null
    // Tear down the "copy link" card on success (the post-sign-in reload
    // also drops it — cleanup is idempotent) and on cancel/error.
    runBannerCleanup()
  }
}

// Re-export the supported provider type for callers that need to
// narrow the union before passing to `handleFirebasePopup`.
export type { SupportedProvider }
