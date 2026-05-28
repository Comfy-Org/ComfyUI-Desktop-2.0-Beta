import { describe, expect, it } from 'vitest'

import { buildIndexedDbInjectScript } from './inject'

describe('buildIndexedDbInjectScript', () => {
  const sampleUser = {
    uid: 'abc123',
    email: 'user@example.com',
    stsTokenManager: { refreshToken: 'rt', accessToken: 'at', expirationTime: 0 },
  }

  it('embeds the user JSON verbatim', () => {
    const script = buildIndexedDbInjectScript(sampleUser, 'AIzaTEST')
    expect(script).toContain('"uid":"abc123"')
    expect(script).toContain('"refreshToken":"rt"')
  })

  it('uses Firebase\'s documented IDB schema', () => {
    const script = buildIndexedDbInjectScript(sampleUser, 'AIzaTEST')
    expect(script).toContain("'firebaseLocalStorageDb'")
    expect(script).toContain("'firebaseLocalStorage'")
    expect(script).toContain('fbase_key')
    expect(script).toContain("firebase:authUser:' + apiKey + ':[DEFAULT]")
  })

  it('reloads the page after the IDB write commits', () => {
    const script = buildIndexedDbInjectScript(sampleUser, 'AIzaTEST')
    expect(script).toContain('location.reload()')
  })

  it('is parseable as JavaScript', () => {
    const script = buildIndexedDbInjectScript(sampleUser, 'AIzaTEST')
    // `Function` constructor surfaces syntax errors without executing the
    // body — IndexedDB is not in scope but the parse alone is enough.
    expect(() => new Function(script)).not.toThrow()
  })

  it('escapes embedded values to prevent script breakage', () => {
    const tricky = { malicious: '"; alert(1); //' }
    const script = buildIndexedDbInjectScript(tricky, 'AIza')
    expect(() => new Function(script)).not.toThrow()
  })
})
