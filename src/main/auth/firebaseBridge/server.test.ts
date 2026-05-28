import { describe, expect, it } from 'vitest'

import { BRIDGE_PORT, startBridgeServer } from './server'

describe('startBridgeServer', () => {
  it('serves a 204 for /favicon.ico', async () => {
    const handle = await startBridgeServer({ env: 'prod', providerId: 'google.com', port: 0 })
    try {
      const res = await fetch(`${handle.url}favicon.ico`)
      expect(res.status).toBe(204)
    } finally {
      handle.close()
    }
  })

  it('serves a 404 for unknown paths', async () => {
    const handle = await startBridgeServer({ env: 'prod', providerId: 'google.com', port: 0 })
    try {
      const res = await fetch(`${handle.url}does-not-exist`)
      expect(res.status).toBe(404)
    } finally {
      handle.close()
    }
  })

  it('serves the error page when the IdP redirects with ?error=...', async () => {
    const handle = await startBridgeServer({ env: 'prod', providerId: 'google.com', port: 0 })
    // Attach the rejection handler BEFORE triggering the error fetch.
    // The ?error= branch rejects signInPromise synchronously while
    // handling the request; if no handler is attached yet, Vitest flags
    // it as an unhandled rejection and fails the whole run.
    const rejected = expect(handle.signInPromise).rejects.toThrow(/IdP error/)
    try {
      const res = await fetch(
        `${handle.url}?error=access_denied&error_description=user+cancelled`,
        { redirect: 'manual' },
      )
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('Sign-in failed')
      expect(body).toContain('user cancelled')
      await rejected
    } finally {
      handle.close()
    }
  })

  it('issues HTTP URL as http://localhost on a loopback port', async () => {
    const handle = await startBridgeServer({ env: 'prod', providerId: 'google.com', port: 0 })
    try {
      expect(handle.url).toMatch(/^http:\/\/localhost:\d+\/$/)
    } finally {
      handle.close()
    }
  })

  it('serves the popup-bridge HTML for github.com providers', async () => {
    const handle = await startBridgeServer({ env: 'prod', providerId: 'github.com', port: 0 })
    try {
      const res = await fetch(handle.url, { redirect: 'manual' })
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('firebase-app.js')
      expect(body).toContain('Continue with')
      expect(body).toContain('"GitHub"')
    } finally {
      handle.close()
    }
  })

  it('302s the browser to Google OAuth for google.com providers (raw-OAuth flow)', async () => {
    const handle = await startBridgeServer({ env: 'prod', providerId: 'google.com', port: 0 })
    try {
      const res = await fetch(handle.url, { redirect: 'manual' })
      expect(res.status).toBe(302)
      const location = res.headers.get('location') || ''
      expect(location).toContain('accounts.google.com')
      expect(location).toContain('client_id=')
    } finally {
      handle.close()
    }
  })

  it('exports the fixed port (9876) used by the Google OAuth client allowlist', () => {
    // Asserting the constant rather than binding — the actual port may
    // be held by a parallel dev process or another test instance, but
    // the contract with the Firebase Google OAuth client redirect-URI
    // allowlist is the constant.
    expect(BRIDGE_PORT).toBe(9876)
  })
})
