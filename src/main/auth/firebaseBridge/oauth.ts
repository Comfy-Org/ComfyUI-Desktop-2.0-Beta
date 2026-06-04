import type { FirebaseProjectConfig } from './config'
import type { SupportedProvider } from './intercept'

const IDP_BASE = 'https://identitytoolkit.googleapis.com/v1'

interface CreateAuthUriResponse {
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
  idToken: string
  refreshToken: string
  /** Seconds until idToken expires. Stringified. */
  expiresIn: string
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
  isNewUser?: boolean
  providerUserInfo?: ProviderUserInfo[]
}

/**
 * Ask Firebase to generate an OAuth URL for the requested IdP, using the
 * bridge's loopback origin as `continueUri`. Firebase lists `localhost` and
 * `127.0.0.1` on the authorized-domains list for both prod and dev projects.
 */
export async function createOauthAuthUri(
  apiKey: string,
  providerId: SupportedProvider,
  continueUri: string,
): Promise<CreateAuthUriResponse> {
  // Scopes mirror Firebase's signInWithPopup to keep the consent screen identical.
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
 * Exchange the OAuth `code` for a Firebase user. `requestUri` MUST be the full
 * URL the IdP redirected the browser to (including the query string).
 */
export async function signInWithIdpExchange(
  apiKey: string,
  providerId: SupportedProvider,
  requestUri: string,
  sessionId: string,
): Promise<SignInWithIdpResponse> {
  const queryStart = requestUri.indexOf('?')
  const queryParams = queryStart >= 0 ? requestUri.slice(queryStart + 1) : ''
  // Firebase expects providerId echoed in the postBody alongside the raw OAuth response.
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
 * `firebase:authUser:<apiKey>:[DEFAULT]`. Must match the SDK's `User.toJSON()`
 * schema for the fields it reads on rehydration (stable across v9-v11).
 */
export function buildPersistedUser(
  config: FirebaseProjectConfig,
  resp: SignInWithIdpResponse,
  providerId: SupportedProvider,
): Record<string, unknown> {
  const nowMs = Date.now()
  const expiresInSec = Number(resp.expiresIn || '3600')
  const expirationTime = nowMs + expiresInSec * 1000
  // Prefer Firebase's parsed list, else synthesise one entry from the top-level fields.
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
    // Stringified ms-epochs; true createdAt is unknown so both default to now and
    // get re-minted on subsequent token refreshes.
    createdAt: String(nowMs),
    lastLoginAt: String(nowMs),
    apiKey: config.apiKey,
    appName: '[DEFAULT]',
  }
}
