import { describe, expect, it } from 'vitest'

import {
  type FirstUseMode,
  isChromeLockedMode,
  isFirstUseLockdownMode,
  isLoadingLockdownMode,
  normaliseFirstUseMode,
} from './firstUseMode'

// Pins the chrome-lockdown taxonomy so the title-bar gates can't
// silently regress. The whole point of the split between first-use
// lockdown (hide chrome) and loading lockdown (keep chrome live) is
// that flipping one bucket should not bleed into the other, so the
// table-driven tests assert every mode explicitly.

const ALL_MODES: FirstUseMode[] = [
  'none',
  'consent-lockdown',
  'post-consent',
  'loading-lockdown',
]

describe('firstUseMode', () => {
  describe('isFirstUseLockdownMode', () => {
    it.each<[FirstUseMode, boolean]>([
      ['none', false],
      ['consent-lockdown', true],
      ['post-consent', true],
      ['loading-lockdown', false],
    ])('%s -> %s', (mode, expected) => {
      expect(isFirstUseLockdownMode(mode)).toBe(expected)
    })
  })

  describe('isLoadingLockdownMode', () => {
    it.each<[FirstUseMode, boolean]>([
      ['none', false],
      ['consent-lockdown', false],
      ['post-consent', false],
      ['loading-lockdown', true],
    ])('%s -> %s', (mode, expected) => {
      expect(isLoadingLockdownMode(mode)).toBe(expected)
    })
  })

  describe('isChromeLockedMode (legacy union)', () => {
    it.each<[FirstUseMode, boolean]>([
      ['none', false],
      ['consent-lockdown', true],
      ['post-consent', true],
      ['loading-lockdown', true],
    ])('%s -> %s', (mode, expected) => {
      expect(isChromeLockedMode(mode)).toBe(expected)
    })

    it('stays consistent with the granular predicates: locked === first-use OR loading', () => {
      for (const mode of ALL_MODES) {
        expect(isChromeLockedMode(mode)).toBe(
          isFirstUseLockdownMode(mode) || isLoadingLockdownMode(mode),
        )
      }
    })
  })

  describe('normaliseFirstUseMode', () => {
    it('passes valid modes through unchanged', () => {
      for (const mode of ALL_MODES) {
        expect(normaliseFirstUseMode(mode)).toBe(mode)
      }
    })

    it.each<[unknown, string]>([
      [undefined, 'undefined'],
      [null, 'null'],
      ['', 'empty string'],
      ['unknown-mode', 'unknown string'],
      [42, 'number'],
      [{ mode: 'consent-lockdown' }, 'object'],
      [['consent-lockdown'], 'array'],
    ])('coerces %s (%s) to "none"', (raw) => {
      expect(normaliseFirstUseMode(raw)).toBe('none')
    })
  })
})
