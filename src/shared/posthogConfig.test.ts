import { describe, it, expect } from 'vitest'
import {
  DEFAULT_POSTHOG_API_KEY,
  isPostHogFlagDisabled,
  isValidPostHogApiKey,
} from './posthogConfig'

describe('isValidPostHogApiKey', () => {
  it('accepts the shipped DEFAULT_POSTHOG_API_KEY (catches a placeholder regression)', () => {
    // If this fails, someone replaced the live phc_… key with a placeholder
    // again. Bare builds would silently ship events to a dropped key.
    expect(isValidPostHogApiKey(DEFAULT_POSTHOG_API_KEY)).toBe(true)
  })
  it('rejects empty / nullish values', () => {
    expect(isValidPostHogApiKey('')).toBe(false)
    expect(isValidPostHogApiKey(undefined)).toBe(false)
    expect(isValidPostHogApiKey(null)).toBe(false)
  })
  it('rejects strings without the phc_ prefix', () => {
    expect(isValidPostHogApiKey('not-a-real-key')).toBe(false)
    expect(isValidPostHogApiKey('pub5b0afc7fe0411fcebad80bb87274d711')).toBe(false)
    expect(isValidPostHogApiKey('PLACEHOLDER')).toBe(false)
  })
  it('rejects the bare prefix with no payload', () => {
    expect(isValidPostHogApiKey('phc_')).toBe(false)
  })
  it('accepts a phc_-prefixed project key', () => {
    expect(isValidPostHogApiKey('phc_test_key')).toBe(true)
    expect(isValidPostHogApiKey('phc_AbCdEf1234567890')).toBe(true)
  })
})

describe('isPostHogFlagDisabled', () => {
  it('treats 0/false/off (any case) as disabled', () => {
    expect(isPostHogFlagDisabled('0')).toBe(true)
    expect(isPostHogFlagDisabled('false')).toBe(true)
    expect(isPostHogFlagDisabled('FALSE')).toBe(true)
    expect(isPostHogFlagDisabled('off')).toBe(true)
    expect(isPostHogFlagDisabled(' Off ')).toBe(true)
  })
  it('treats anything else (including undefined) as not-disabled', () => {
    expect(isPostHogFlagDisabled(undefined)).toBe(false)
    expect(isPostHogFlagDisabled('')).toBe(false)
    expect(isPostHogFlagDisabled('1')).toBe(false)
    expect(isPostHogFlagDisabled('true')).toBe(false)
  })
})
