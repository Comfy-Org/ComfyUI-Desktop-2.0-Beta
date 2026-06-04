/**
 * Bridge-page HTML rendered to the user's system browser. Two flows
 * share these helpers depending on provider:
 *
 *  - Google: server-driven raw OAuth (`createAuthUri` → HTTP 302 →
 *    provider → 302 back to `signInWithIdp`). The user's browser only
 *    sees a terminal state — "Signed in" or "Sign-in failed".
 *
 *  - GitHub: client-driven popup bridge — the page initialises Firebase
 *    JS SDK and calls `signInWithPopup` (gated behind a button click so
 *    popup-blockers can't fire). Used because GitHub OAuth Apps only
 *    permit a single Authorization Callback URL (reserved for web
 *    sign-in), so the loopback raw-OAuth flow can't be used.
 */

import type { FirebaseProjectConfig } from './config'
import type { SupportedProvider } from './intercept'

const FIREBASE_SDK_VERSION = '10.14.1'

const PROVIDER_LABEL: Record<SupportedProvider, string> = {
  'google.com': 'Google',
  'github.com': 'GitHub',
}

const PROVIDER_ICON: Record<SupportedProvider, string> = {
  'google.com': `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.92a8.78 8.78 0 0 0 2.68-6.6z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.95v2.33A9 9 0 0 0 9 18z"/>
    <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.69 9c0-.6.1-1.18.28-1.72V4.95H.95A9 9 0 0 0 0 9c0 1.45.35 2.83.95 4.05l3.02-2.33z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0a9 9 0 0 0-8.05 4.95L3.97 7.28C4.68 5.16 6.66 3.58 9 3.58z"/>
  </svg>`,
  'github.com': `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
    <path fill="currentColor" d="M9 0a9 9 0 0 0-2.85 17.54c.45.08.62-.2.62-.43v-1.5c-2.5.55-3.03-1.21-3.03-1.21-.41-1.04-1-1.32-1-1.32-.82-.56.06-.55.06-.55.9.06 1.38.93 1.38.93.8 1.38 2.11.98 2.62.75.08-.59.32-.99.57-1.22-1.99-.23-4.09-1-4.09-4.43 0-.98.35-1.78.93-2.41-.09-.23-.4-1.14.09-2.37 0 0 .75-.24 2.48.92a8.5 8.5 0 0 1 4.5 0c1.72-1.16 2.48-.92 2.48-.92.49 1.23.18 2.14.09 2.37.58.63.93 1.43.93 2.41 0 3.44-2.1 4.2-4.1 4.42.33.28.62.83.62 1.67v2.47c0 .24.16.52.62.43A9 9 0 0 0 9 0z"/>
  </svg>`,
}

const COMFY_MARK = `<img src="data:image/png;base64,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" width="56" height="56" alt="ComfyUI" style="display:block;border-radius:12px" />`

const CHECK_ICON = `<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
  <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M7 12.5l3.2 3.2 6.8-6.8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const ERROR_ICON = `<svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true">
  <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="2"/>
  <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f5f5f7;
  --surface: #ffffff;
  --text: #111;
  --muted: #6b6b73;
  --border: #e6e6ea;
  --success: #16a34a;
  --error: #c1272d;
  --error-bg: #fdecec;
  --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 32px rgba(0,0,0,0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e10;
    --surface: #18181b;
    --text: #ededf0;
    --muted: #9b9ba3;
    --border: #2a2a2f;
    --success: #4ade80;
    --error: #ff6b6b;
    --error-bg: #2b1414;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 32px rgba(0,0,0,0.4);
  }
}
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  -webkit-font-smoothing: antialiased;
}
.card {
  width: 100%;
  max-width: 420px;
  padding: 36px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: var(--shadow);
  text-align: center;
}
.brand { display: flex; justify-content: center; margin-bottom: 24px; }
.status-icon { margin: 0 auto 20px; }
.status-icon.success { color: var(--success); }
.status-icon.error { color: var(--error); }
h1 {
  font-size: 22px;
  font-weight: 600;
  margin: 0 0 10px;
  letter-spacing: -0.2px;
}
p { color: var(--muted); margin: 0; line-height: 1.55; font-size: 14px; }
.hint {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.error-block {
  margin-top: 18px;
  padding: 12px 14px;
  background: var(--error-bg);
  color: var(--error);
  border-radius: 8px;
  font-size: 13px;
  text-align: left;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  width: 100%;
  margin-top: 24px;
  padding: 12px 20px;
  background: var(--text);
  color: var(--surface);
  border: 0;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: background 120ms ease, transform 80ms ease;
}
.btn:hover { filter: brightness(1.1); }
.btn:active { transform: scale(0.99); }
.btn:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
.btn[disabled] { opacity: 0.65; cursor: not-allowed; }
.btn-spinner {
  width: 14px; height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.hint {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
@keyframes spin { to { transform: rotate(360deg); } }
`

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="brand">${COMFY_MARK}</div>
    ${body}
  </div>
</body>
</html>`
}

/**
 * Terminal success page shown when the OAuth callback completes and
 * the user has been injected into the Desktop view. Renders a
 * countdown synchronised with the server-side `POST_SIGNIN_HOLD_MS`
 * delay so the page doesn't disappear out from under the user the
 * instant Google completes — focus only shifts after the counter
 * reaches zero.
 */
export function renderDoneHtml(): string {
  return shell(
    "You're signed in — Comfy Desktop",
    `<div class="status-icon success">${CHECK_ICON}</div>
    <h1>You're signed in</h1>
    <p id="countdown">Returning to Comfy Desktop in 3…</p>
    <div class="hint">You can close this tab when you're back in the app.</div>
    <script>
      (function(){
        var n = 3;
        var el = document.getElementById('countdown');
        function tick(){
          n -= 1;
          if (n <= 0) {
            el.textContent = 'Returning to Comfy Desktop…';
            // Best-effort tab close. Browsers block window.close on tabs
            // that weren't opened by window.open() — but Chrome / Safari
            // increasingly allow it when the tab originated from an
            // external-app deep link (shell.openExternal). If blocked,
            // the user just keeps seeing this page until they close it.
            setTimeout(function(){ try { window.close() } catch (_) {} }, 250);
            return;
          }
          el.textContent = 'Returning to Comfy Desktop in ' + n + '…';
          setTimeout(tick, 1000);
        }
        setTimeout(tick, 1000);
      })();
    </script>`,
  )
}

/**
 * Terminal error page for IdP-denied or Firebase-exchange failures.
 * The user can retry by returning to Comfy Desktop and clicking
 * Sign in again.
 */
export function renderErrorHtml(message: string): string {
  return shell(
    'Sign-in failed — Comfy Desktop',
    `<div class="status-icon error">${ERROR_ICON}</div>
    <h1>Sign-in failed</h1>
    <p>We weren't able to complete sign-in. Return to Comfy Desktop and click Sign in again to retry.</p>
    <div class="error-block">${escapeHtml(message)}</div>`,
  )
}

/**
 * Provider-bridge page used for IdPs that can't use the raw OAuth
 * loopback flow (today: GitHub — its OAuth Apps allow only a single
 * Authorization Callback URL, reserved for web). The page initialises
 * Firebase JS SDK and runs `signInWithPopup` from a user gesture (the
 * "Continue with X" button — gated so popup-blockers don't fire).
 * Auto-attempt on load handles browsers that allow external-app-opened
 * tabs to popup once without explicit interaction.
 *
 * On success the page POSTs `auth.currentUser.toJSON()` to `/callback`
 * — same payload shape the IndexedDB injection script expects.
 */
export function renderPopupBridgeHtml(
  firebaseConfig: FirebaseProjectConfig,
  providerId: SupportedProvider,
): string {
  const configJson = JSON.stringify(firebaseConfig)
  const providerJson = JSON.stringify(providerId)
  const providerLabelJson = JSON.stringify(PROVIDER_LABEL[providerId])
  const providerIconJson = JSON.stringify(PROVIDER_ICON[providerId])
  const sdkBase = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Sign in to Comfy Desktop</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <div class="brand">${COMFY_MARK}</div>
    <div id="content"></div>
  </div>
  <script type="module">
    import { initializeApp } from '${sdkBase}/firebase-app.js'
    import {
      getAuth,
      GoogleAuthProvider,
      GithubAuthProvider,
      signInWithPopup,
      getRedirectResult,
    } from '${sdkBase}/firebase-auth.js'

    const firebaseConfig = ${configJson}
    const providerId = ${providerJson}
    const providerLabel = ${providerLabelJson}
    const providerIcon = ${providerIconJson}

    const contentEl = document.getElementById('content')

    function escapeHtml(s) {
      return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
    }

    function renderIdle(errorMessage) {
      const err = errorMessage ? '<div class="error-block">' + escapeHtml(errorMessage) + '</div>' : ''
      contentEl.innerHTML = \`
        <h1>\${errorMessage ? 'Try sign-in again' : 'Sign in to continue'}</h1>
        <p>Your browser keeps the passkeys, saved passwords, and provider sessions that the embedded popup can't.</p>
        <button class="btn" id="signinBtn" type="button">
          \${providerIcon}
          <span>Continue with \${providerLabel}</span>
        </button>
        \${err}
        <div class="hint">You'll be returned to Comfy Desktop automatically once sign-in completes.</div>
      \`
      document.getElementById('signinBtn').addEventListener('click', onClick)
    }

    function renderWorking() {
      contentEl.innerHTML = \`
        <h1>Finish in the popup</h1>
        <p>Complete sign-in with \${providerLabel} in the window that just opened.</p>
        <button class="btn" type="button" disabled>
          <span class="btn-spinner"></span>
          <span>Waiting for \${providerLabel}...</span>
        </button>
      \`
    }

    function renderDone() {
      contentEl.innerHTML = \`
        <div class="status-icon success">${CHECK_ICON}</div>
        <h1>You're signed in</h1>
        <p id="countdown">Returning to Comfy Desktop in 3…</p>
        <div class="hint">You can close this tab when you're back in the app.</div>
      \`
      var n = 3
      var el = document.getElementById('countdown')
      function tick(){
        n -= 1
        if (n <= 0) {
          el.textContent = 'Returning to Comfy Desktop…'
          setTimeout(function(){ try { window.close() } catch (_) {} }, 250)
          return
        }
        el.textContent = 'Returning to Comfy Desktop in ' + n + '…'
        setTimeout(tick, 1000)
      }
      setTimeout(tick, 1000)
    }

    function buildProvider() {
      if (providerId === 'github.com') {
        const p = new GithubAuthProvider()
        p.addScope('read:user')
        p.addScope('user:email')
        return p
      }
      const p = new GoogleAuthProvider()
      p.addScope('profile')
      p.addScope('email')
      return p
    }

    let auth
    try {
      const app = initializeApp(firebaseConfig)
      auth = getAuth(app)
    } catch (err) {
      contentEl.innerHTML = '<h1>Sign-in unavailable</h1><p>The Firebase SDK failed to load. Please reopen sign-in from Comfy Desktop.</p>'
      throw err
    }

    async function runSignIn() {
      const result = await signInWithPopup(auth, buildProvider())
      if (!result || !result.user) throw new Error('Sign-in completed without a user')
      const resp = await fetch('/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: result.user.toJSON() }),
      })
      if (!resp.ok) throw new Error('Callback responded ' + resp.status)
    }

    async function onClick() {
      renderWorking()
      try {
        await runSignIn()
        renderDone()
      } catch (err) {
        renderIdle((err && err.message) || String(err))
      }
    }

    async function postUserAndFinish(user) {
      const resp = await fetch('/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user.toJSON() }),
      })
      if (!resp.ok) throw new Error('Callback responded ' + resp.status)
    }

    // Auto-attempt on load: a tab opened by shell.openExternal often
    // has transient activation in Chrome and allows one popup. Falls
    // back to the manual button when the browser blocks it. We also
    // handle Firebase's internal popup-to-redirect fallback by first
    // checking for a redirect result — when the URL has code+state
    // from an in-flight Firebase redirect, getRedirectResult resolves
    // with the user even though we never explicitly called signInWithRedirect.
    async function autoAttempt() {
      renderWorking()
      try {
        const redirectResult = await getRedirectResult(auth)
        if (redirectResult && redirectResult.user) {
          await postUserAndFinish(redirectResult.user)
          renderDone()
          return
        }
        await runSignIn()
        renderDone()
      } catch (err) {
        const code = err && err.code
        if (code === 'auth/popup-blocked' || code === 'auth/cancelled-popup-request') {
          renderIdle(null)
        } else {
          renderIdle((err && err.message) || String(err))
        }
      }
    }

    autoAttempt()
  </script>
</body>
</html>`
}
