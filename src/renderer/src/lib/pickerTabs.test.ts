import { describe, expect, it } from 'vitest'
import { isPickerTab, isTabAllowedForCategory, resolvePickerTab } from './pickerTabs'

describe('pickerTabs', () => {
  describe('isPickerTab', () => {
    it('accepts known tabs and rejects everything else', () => {
      expect(isPickerTab('console')).toBe(true)
      expect(isPickerTab('config')).toBe(true)
      expect(isPickerTab('nope')).toBe(false)
      expect(isPickerTab(null)).toBe(false)
      expect(isPickerTab(undefined)).toBe(false)
    })
  })

  describe('resolvePickerTab', () => {
    it('coerces unknown ids to the fallback', () => {
      expect(resolvePickerTab('status', 'update')).toBe('status')
      expect(resolvePickerTab('garbage', 'update')).toBe('update')
      expect(resolvePickerTab(null, 'update')).toBe('update')
    })
  })

  describe('isTabAllowedForCategory', () => {
    it('hides Console for cloud and remote (no local PTY to attach a shell to)', () => {
      expect(isTabAllowedForCategory('console', 'cloud')).toBe(false)
      expect(isTabAllowedForCategory('console', 'remote')).toBe(false)
    })

    it('allows Console for local instances', () => {
      expect(isTabAllowedForCategory('console', 'local')).toBe(true)
    })

    it('allows non-console tabs for every category', () => {
      for (const cat of ['local', 'cloud', 'remote']) {
        expect(isTabAllowedForCategory('update', cat)).toBe(true)
        expect(isTabAllowedForCategory('status', cat)).toBe(true)
      }
    })

    it('allows everything for an unknown / undefined category (section-gating still applies)', () => {
      expect(isTabAllowedForCategory('console', undefined)).toBe(true)
      expect(isTabAllowedForCategory('console', 'mystery')).toBe(true)
    })
  })
})
