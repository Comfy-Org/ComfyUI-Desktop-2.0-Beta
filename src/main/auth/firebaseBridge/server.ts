import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { renderDoneHtml, renderErrorHtml, renderPopupBridgeHtml } from './bridgeHtml'
import { getFirebaseConfig, type FirebaseEnv } from './config'
import type { SupportedProvider } from './intercept'
import {
  buildPersistedUser,
  createOauthAuthUri,
  signInWithIdpExchange,
} from './oauth'

const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Result handed to the orchestrator when the OAuth dance lands at our
 * loopback callback and the Firebase exchange succeeds. `user` is the
 * JSON shape Firebase JS SDK persists in IndexedDB at
 * `firebase:authUser:<apiKey>:[DEFAULT]`.
 */
export interface SignInResult {
  user: Record<string, unknown>
  apiKey: string
}

export interface BridgeHandle {
  /** URL to hand to `shell.openExternal` to start the sign-in flow. */
  url: string
  /** Resolves once the IdP callback completes and Firebase mints a user. */
  signInPromise: Promise<SignInResult>
  /** Shut the server down. Safe to call multiple times. */
  close: () => void
}

/**
 * Fixed loopback port for the OAuth callback. The Firebase Google
 * OAuth client has `http://localhost:9876` registered as an authorized
 * redirect URI — Google's policy for Web OAuth clients is exact-match
 * (port included), so we have to commit to a specific port. 9876 is
 * outside the well-known ephemeral range used by browsers / system
 * tools, so collision risk is low in practice.
 */
export const BRIDGE_PORT = 9876

export interface StartBridgeOpts {
  env: FirebaseEnv
  providerId: SupportedProvider
  /** Default 5 minutes — long enough for password managers, 2FA, account-picker UI. */
  timeoutMs?: number
  /** Override the loopback port. Defaults to `BRIDGE_PORT` (9876). Tests pass `0` to get a kernel-assigned port. */
  port?: number
}

/**
 * Start the loopback bridge. Binds `127.0.0.1:<port>` (default 9876,
 * RFC 8252 §7 compliant loopback) and advertises the URL as
 * `http://localhost:<port>` — Firebase's Google OAuth client requires
 * the redirect URI to match exactly, so the fixed port is registered
 * in Google Cloud Console alongside the Firebase auth handler URIs.
 *
 * Flow:
 *   GET /         (no query)              → call Firebase createAuthUri,
 *                                            stash sessionId in closure,
 *                                            HTTP 302 to the IdP authorize
 *                                            URL. No client-side JS needed.
 *   GET /?code=…&state=…                 → IdP callback. Call Firebase
 *                                            signInWithIdp to exchange the
 *                                            code for Firebase tokens,
 *                                            build the persisted-user JSON,
 *                                            resolve signInPromise, serve
 *                                            the "Signed in" HTML.
 *   GET /?error=…                        → IdP denied / user cancelled.
 *                                            Reject signInPromise and serve
 *                                            the error HTML.
 *   anything else                        → 404.
 */
export function startBridgeServer(opts: StartBridgeOpts): Promise<BridgeHandle> {
  const { env, providerId, timeoutMs = 5 * 60_000, port = BRIDGE_PORT } = opts
  const firebaseConfig = getFirebaseConfig(env)

  return new Promise((resolveHandle, rejectHandle) => {
    let resolved = false
    let sessionId: string | null = null
    let signInResolve!: (r: SignInResult) => void
    let signInReject!: (err: Error) => void
    const signInPromise = new Promise<SignInResult>((res, rej) => {
      signInResolve = res
      signInReject = rej
    })

    let server: Server | null = null

    const close = (): void => {
      if (server) {
        try {
          // closeAllConnections() force-terminates any keep-alive sockets
          // browsers may have established — without it, the browser would
          // happily reuse a pinned TCP connection to a "closed" server on
          // the next localhost:9876 fetch, routing requests into the OLD
          // closure (with the OLD providerId, OLD signInPromise, etc.).
          // close() alone only stops accepting new connections.
          server.closeAllConnections?.()
          server.close()
        } catch {
          // ignore — best-effort shutdown
        }
        server = null
      }
      clearTimeout(timeoutHandle)
    }

    const finishWithError = (err: Error): void => {
      if (!resolved) {
        resolved = true
        signInReject(err)
      }
    }

    const finishWithSuccess = (result: SignInResult): void => {
      if (!resolved) {
        resolved = true
        signInResolve(result)
      }
    }

    const timeoutHandle = setTimeout(() => {
      finishWithError(new Error('Firebase bridge timed out waiting for sign-in'))
      close()
    }, timeoutMs)

    server = createServer((req, res) => {
      // Disable HTTP keep-alive so the bridge never holds onto sockets
      // across the singleton-driven server swap. Browsers would
      // otherwise reuse a connection pinned to a previous bridge's
      // closure (with the wrong providerId / dead server reference).
      res.setHeader('Connection', 'close')
      void handleRequest(req, res).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(renderErrorHtml(msg))
        }
        finishWithError(err instanceof Error ? err : new Error(msg))
      })
    })

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      // Belt-and-braces: only honour requests on the loopback socket.
      // The bind itself enforces this; this is a defence-in-depth check.
      const remoteHost = req.socket.remoteAddress ?? ''
      const isLoopback =
        remoteHost === '127.0.0.1' || remoteHost === '::1' || remoteHost === '::ffff:127.0.0.1'
      if (!isLoopback) {
        res.statusCode = 403
        res.end()
        return
      }

      const url = req.url ?? '/'
      const queryStart = url.indexOf('?')
      const path = queryStart >= 0 ? url.slice(0, queryStart) : url
      const search = queryStart >= 0 ? url.slice(queryStart + 1) : ''
      const params = new URLSearchParams(search)

      if (req.method === 'GET' && path === '/favicon.ico') {
        res.statusCode = 204
        res.end()
        return
      }

      // Popup-bridge callback (GitHub flow only): the in-browser
      // Firebase SDK POSTs `auth.currentUser.toJSON()` here after a
      // successful signInWithPopup. We forward it to the orchestrator
      // for IndexedDB injection.
      if (req.method === 'POST' && path === '/callback') {
        if (providerId !== 'github.com') {
          res.statusCode = 404
          res.end()
          return
        }
        const body = (await readJsonBody(req)) as { user?: Record<string, unknown> }
        if (!body || typeof body !== 'object' || !body.user || typeof body.user !== 'object') {
          res.statusCode = 400
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Missing user payload')
          return
        }
        res.statusCode = 204
        res.end()
        finishWithSuccess({ user: body.user, apiKey: firebaseConfig.apiKey })
        return
      }

      if (req.method !== 'GET' || path !== '/') {
        res.statusCode = 404
        res.end()
        return
      }

      // IdP returned an explicit error (user denied consent, etc.)
      const idpError = params.get('error')
      if (idpError) {
        const description =
          params.get('error_description') || params.get('error_message') || idpError
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(renderErrorHtml(description))
        finishWithError(new Error(`IdP error: ${description}`))
        return
      }

      const code = params.get('code')
      const state = params.get('state')

      // Raw-OAuth callback arm — only relevant for Google (we drove the
      // OAuth dance server-side via createAuthUri). For GitHub the
      // bridge page handles the credential client-side (popup or
      // Firebase JS SDK's redirect-fallback), so we fall through to
      // serve the bridge HTML again on code+state arrival.
      if (code && state && providerId === 'google.com') {
        if (!sessionId) {
          // Should not happen — would mean a callback arrived without
          // a prior GET / on this server instance.
          throw new Error('Callback arrived before initiator')
        }
        // Reconstruct the full URL the IdP redirected to; signInWithIdp
        // parses query params from this string the same way the JS SDK does.
        const requestUri = `http://localhost:${(server!.address() as AddressInfo).port}${url}`
        const idpResponse = await signInWithIdpExchange(
          firebaseConfig.apiKey,
          providerId,
          requestUri,
          sessionId,
        )
        const persistedUser = buildPersistedUser(firebaseConfig, idpResponse, providerId)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(renderDoneHtml())
        finishWithSuccess({ user: persistedUser, apiKey: firebaseConfig.apiKey })
        return
      }

      // Initiator arm — first GET / with no callback params. Two flows:
      //
      //   Google: 302 to Google's OAuth URL (raw-OAuth zero-click flow).
      //           Requires `http://localhost:<port>/` to be on the
      //           Firebase Google OAuth client's authorized redirect
      //           URIs (one-time Google Cloud Console setup).
      //
      //   GitHub: serve the popup-bridge HTML which initialises Firebase
      //           JS SDK and runs signInWithPopup. Used because GitHub
      //           OAuth Apps only allow a single Authorization Callback
      //           URL (already reserved for web sign-in), so the loopback
      //           redirect URI can't be added.
      if (providerId === 'google.com') {
        const continueUri = `http://localhost:${(server!.address() as AddressInfo).port}/`
        const authResp = await createOauthAuthUri(firebaseConfig.apiKey, providerId, continueUri)
        sessionId = authResp.sessionId
        res.statusCode = 302
        res.setHeader('Location', authResp.authUri)
        res.setHeader('Cache-Control', 'no-store')
        res.end()
        return
      }

      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(renderPopupBridgeHtml(firebaseConfig, providerId))
    }

    server.on('error', (err: Error) => {
      finishWithError(err)
      rejectHandle(err)
      close()
    })

    server.listen(port, '127.0.0.1', () => {
      const addr = server!.address() as AddressInfo
      const url = `http://localhost:${addr.port}/`
      resolveHandle({ url, signInPromise, close })
    })
  })
}
