import { describe, expect, it } from 'vitest'

import { friendlyAuthErrorMessage, renderErrorHtml, renderPopupBridgeHtml } from './bridgeHtml'
import { getFirebaseConfig } from './config'

describe('friendlyAuthErrorMessage', () => {
  it('maps known Firebase auth codes to friendly copy', () => {
    expect(friendlyAuthErrorMessage('auth/account-exists-with-different-credential')).toContain(
      'already exists',
    )
    expect(friendlyAuthErrorMessage('auth/network-request-failed')).toContain('internet connection')
    expect(friendlyAuthErrorMessage('auth/popup-closed-by-user')).toContain('cancelled')
  })

  it('falls back to a generic message for unknown / missing codes', () => {
    const generic = 'Sign-in failed. Please try again.'
    expect(friendlyAuthErrorMessage('auth/something-new')).toBe(generic)
    expect(friendlyAuthErrorMessage(null)).toBe(generic)
    expect(friendlyAuthErrorMessage(undefined)).toBe(generic)
    expect(friendlyAuthErrorMessage('')).toBe(generic)
  })

  it('never returns a raw auth code or the word "Firebase"', () => {
    for (const code of [
      'auth/account-exists-with-different-credential',
      'auth/popup-closed-by-user',
      'auth/network-request-failed',
      'auth/internal-error',
      'auth/unknown-code',
    ]) {
      const msg = friendlyAuthErrorMessage(code)
      expect(msg.toLowerCase()).not.toContain('firebase')
      expect(msg).not.toContain('auth/')
    }
  })
})

describe('renderErrorHtml', () => {
  it('renders friendly copy and no monospace technical block', () => {
    const html = renderErrorHtml('We couldn’t reach the sign-in service. Please try again.')
    expect(html).toContain('Sign-in failed')
    expect(html).toContain('reach the sign-in service')
    expect(html).not.toContain('error-block')
  })

  it('falls back to generic copy when given an empty message', () => {
    const html = renderErrorHtml('')
    expect(html).toContain('Sign-in failed. Please try again.')
  })
})

describe('renderPopupBridgeHtml', () => {
  it('inlines the friendly auth-error map and never shows raw err.message', () => {
    const html = renderPopupBridgeHtml(getFirebaseConfig('prod'), 'github.com')
    // The friendly map is inlined for the client script.
    expect(html).toContain('auth/account-exists-with-different-credential')
    expect(html).toContain('friendlyError')
    // Raw error message is no longer surfaced to the user.
    expect(html).not.toContain('(err && err.message) || String(err)')
    // The "Firebase SDK failed to load" leak is gone.
    expect(html).not.toContain('The Firebase SDK failed to load')
  })
})
