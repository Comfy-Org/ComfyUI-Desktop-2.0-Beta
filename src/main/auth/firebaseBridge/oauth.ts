import type { FirebaseProjectConfig } from './config'
import type { SupportedProvider } from './intercept'

/**
 * Google Identity Toolkit (Firebase Identity Platform) REST endpoints.
 * Both are key-authed with the project's public Firebase apiKey — no
 * service-account credentials needed.
 */
const IDP_BASE = 'https://identitytoolkit.googleapis.com/v1'

interface CreateAuthUriResponse {
  /** Full OAuth URL to redirect the browser to. Includes the provider's client_id, the redirect_uri we pass, and a Firebase-managed `state`. */
  authUri: string
  /** Opaque token we must echo back on signInWithIdp so Firebase can match the in-flight session. */
  sessionId: string
  providerId: string
}

interface ProviderUserInfo {
  providerId?: string
  rawId?: string
  email?: string
  displayName?: string
  photoUrl?: string
}

interface SignInWithIdpResponse {
  /** Firebase ID token (JWT). */
  idToken: string
  /** Firebase refresh token (long-lived). */
  refreshToken: string
  /** Seconds until idToken expires. Stringified. */
  expiresIn: string
  /** Firebase UID. */
  localId: string
  email?: string
  emailVerified?: boolean
  displayName?: string
  photoUrl?: string
  providerId?: string
  rawUserInfo?: string
  oauthAccessToken?: string
  oauthIdToken?: string
  federatedId?: string
  rawId?: string
  /** Present when the user is newly created (first sign-in). */
  isNewUser?: boolean
  /** When Firebase returns multi-provider data. */
  providerUserInfo?: ProviderUserInfo[]
}

/**
 * Ask Firebase to generate an OAuth URL for the requested IdP. Firebase
 * resolves the project's registered OAuth client (e.g. the Google
 * client configured in the Firebase Console under Sign-in method →
 * Google) and builds the authorize URL with our `continueUri` as the
 * redirect target.
 *
 * We pass the bridge's loopback origin as `continueUri`. Firebase
 * lists `localhost` and `127.0.0.1` on the authorized-domains list for
 * both prod (`dreamboothy`) and dev (`dreamboothy-dev`) projects, so
 * the resulting URL is accepted at the IdP without further config.
 */
export async function createOauthAuthUri(
  apiKey: string,
  providerId: SupportedProvider,
  continueUri: string,
): Promise<CreateAuthUriResponse> {
  // Scopes mirror what Firebase's own signInWithPopup requests — keeps
  // the consent screen identical to a normal sign-in.
  const oauthScope =
    providerId === 'github.com' ? 'read:user user:email' : 'profile email'
  const resp = await fetch(`${IDP_BASE}/accounts:createAuthUri?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId, continueUri, oauthScope }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`createAuthUri ${resp.status}: ${text || resp.statusText}`)
  }
  const data = (await resp.json()) as CreateAuthUriResponse
  if (!data.authUri || !data.sessionId) {
    throw new Error('createAuthUri returned without authUri/sessionId')
  }
  return data
}

/**
 * Exchange the OAuth `code` returned by the IdP for a Firebase user.
 * Firebase verifies the code against the IdP server-side, mints a
 * Firebase ID token + refresh token, and returns the user record.
 *
 * `requestUri` MUST be the full URL the IdP redirected the browser to
 * (including the query string with `code`, `state`, `scope`, etc.) —
 * Firebase parses it the same way the JS SDK would.
 */
export async function signInWithIdpExchange(
  apiKey: string,
  providerId: SupportedProvider,
  requestUri: string,
  sessionId: string,
): Promise<SignInWithIdpResponse> {
  const queryStart = requestUri.indexOf('?')
  const queryParams = queryStart >= 0 ? requestUri.slice(queryStart + 1) : ''
  // Firebase expects providerId echoed in the postBody alongside the
  // raw OAuth response — same shape the JS SDK sends.
  const postBody = `${queryParams}&providerId=${encodeURIComponent(providerId)}`
  const resp = await fetch(`${IDP_BASE}/accounts:signInWithIdp?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody,
      requestUri,
      sessionId,
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`signInWithIdp ${resp.status}: ${text || resp.statusText}`)
  }
  return (await resp.json()) as SignInWithIdpResponse
}

/**
 * Build the JSON shape Firebase JS SDK persists to IndexedDB at
 * `firebase:authUser:<apiKey>:[DEFAULT]`. The Firebase SDK calls
 * `User.toJSON()` on every persistence write — so our hand-built
 * object must match that schema byte-for-byte (within the fields the
 * SDK reads back on rehydration). Schema is stable across v9-v11.
 */
export function buildPersistedUser(
  config: FirebaseProjectConfig,
  resp: SignInWithIdpResponse,
  providerId: SupportedProvider,
): Record<string, unknown> {
  const nowMs = Date.now()
  const expiresInSec = Number(resp.expiresIn || '3600')
  const expirationTime = nowMs + expiresInSec * 1000
  // Provider data: prefer Firebase's parsed list, else synthesise a
  // single entry from the top-level fields it returned.
  const providerData =
    resp.providerUserInfo && resp.providerUserInfo.length > 0
      ? resp.providerUserInfo.map((p) => ({
          providerId: p.providerId ?? providerId,
          uid: p.rawId ?? resp.localId,
          displayName: p.displayName ?? null,
          email: p.email ?? null,
          phoneNumber: null,
          photoURL: p.photoUrl ?? null,
        }))
      : [
          {
            providerId,
            uid: resp.federatedId ?? resp.rawId ?? resp.localId,
            displayName: resp.displayName ?? null,
            email: resp.email ?? null,
            phoneNumber: null,
            photoURL: resp.photoUrl ?? null,
          },
        ]

  return {
    uid: resp.localId,
    email: resp.email ?? null,
    emailVerified: resp.emailVerified ?? false,
    displayName: resp.displayName ?? null,
    isAnonymous: false,
    photoURL: resp.photoUrl ?? null,
    phoneNumber: null,
    tenantId: null,
    providerData,
    stsTokenManager: {
      refreshToken: resp.refreshToken,
      accessToken: resp.idToken,
      expirationTime,
    },
    // Firebase JS SDK stores these as stringified ms-epochs. We don't
    // know the true createdAt server-side, so we set both to now —
    // subsequent token refreshes will re-mint these from the server.
    createdAt: String(nowMs),
    lastLoginAt: String(nowMs),
    apiKey: config.apiKey,
    appName: '[DEFAULT]',
  }
}
