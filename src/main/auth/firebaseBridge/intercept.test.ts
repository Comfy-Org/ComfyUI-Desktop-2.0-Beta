import { describe, expect, it } from 'vitest'

import { extractProviderId, isFirebaseAuthHandlerUrl } from './intercept'

describe('isFirebaseAuthHandlerUrl', () => {
  it('matches the prod Firebase auth handler', () => {
    expect(
      isFirebaseAuthHandlerUrl(
        'https://dreamboothy.firebaseapp.com/__/auth/handler?apiKey=AIza&providerId=google.com',
      ),
    ).toBe(true)
  })

  it('matches the dev Firebase auth handler', () => {
    expect(
      isFirebaseAuthHandlerUrl(
        'https://dreamboothy-dev.firebaseapp.com/__/auth/handler?providerId=github.com',
      ),
    ).toBe(true)
  })

  it('rejects look-alike hosts', () => {
    expect(
      isFirebaseAuthHandlerUrl(
        'https://dreamboothy.firebaseapp.com.evil.com/__/auth/handler',
      ),
    ).toBe(false)
  })

  it('rejects http (non-TLS) URLs', () => {
    expect(
      isFirebaseAuthHandlerUrl('http://dreamboothy.firebaseapp.com/__/auth/handler'),
    ).toBe(false)
  })

  it('rejects other paths on the Firebase host', () => {
    expect(
      isFirebaseAuthHandlerUrl('https://dreamboothy.firebaseapp.com/some/other/path'),
    ).toBe(false)
  })

  it('rejects unrelated URLs', () => {
    expect(isFirebaseAuthHandlerUrl('https://accounts.google.com/o/oauth2/auth')).toBe(false)
    expect(isFirebaseAuthHandlerUrl('https://cloud.comfy.org/')).toBe(false)
  })

  it('rejects unparseable inputs', () => {
    expect(isFirebaseAuthHandlerUrl('')).toBe(false)
    expect(isFirebaseAuthHandlerUrl('not a url')).toBe(false)
  })
})

describe('extractProviderId', () => {
  it('returns google.com for the Google IdP', () => {
    expect(
      extractProviderId(
        'https://dreamboothy.firebaseapp.com/__/auth/handler?providerId=google.com&apiKey=AIza',
      ),
    ).toBe('google.com')
  })

  it('returns github.com for the GitHub IdP', () => {
    expect(
      extractProviderId(
        'https://dreamboothy.firebaseapp.com/__/auth/handler?providerId=github.com',
      ),
    ).toBe('github.com')
  })

  it('returns null for unsupported providers', () => {
    expect(
      extractProviderId(
        'https://dreamboothy.firebaseapp.com/__/auth/handler?providerId=facebook.com',
      ),
    ).toBeNull()
  })

  it('returns null when providerId is missing', () => {
    expect(
      extractProviderId('https://dreamboothy.firebaseapp.com/__/auth/handler'),
    ).toBeNull()
  })

  it('returns null for unparseable input', () => {
    expect(extractProviderId('')).toBeNull()
  })
})
