import { describe, expect, it } from 'vitest'

import { detectFirebaseEnv, getFirebaseConfig } from './config'

describe('detectFirebaseEnv', () => {
  it('returns dev for the dev Firebase host', () => {
    expect(
      detectFirebaseEnv('https://dreamboothy-dev.firebaseapp.com/__/auth/handler'),
    ).toBe('dev')
  })

  it('returns prod for the prod Firebase host', () => {
    expect(detectFirebaseEnv('https://dreamboothy.firebaseapp.com/__/auth/handler')).toBe(
      'prod',
    )
  })

  it('defaults to prod for unparseable URLs', () => {
    expect(detectFirebaseEnv('not a url')).toBe('prod')
  })
})

describe('getFirebaseConfig', () => {
  it('returns the dev project config when env is dev', () => {
    const config = getFirebaseConfig('dev')
    expect(config.projectId).toBe('dreamboothy-dev')
    expect(config.authDomain).toBe('dreamboothy-dev.firebaseapp.com')
    expect(config.apiKey).toMatch(/^AIza/)
  })

  it('returns the prod project config when env is prod', () => {
    const config = getFirebaseConfig('prod')
    expect(config.projectId).toBe('dreamboothy')
    expect(config.authDomain).toBe('dreamboothy.firebaseapp.com')
    expect(config.apiKey).toMatch(/^AIza/)
  })
})
