import { describe, it, expect } from 'vitest'
import { POPUP_ALLOWED_PREFIXES, shouldOpenInPopup, isDirectDownloadUrl } from './allowedPopups'

describe('POPUP_ALLOWED_PREFIXES', () => {
  it('includes the Firebase auth domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://dreamboothy.firebaseapp.com/')
  })

  it('includes the checkout domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://checkout.comfy.org/')
  })

  it('includes the Google accounts domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://accounts.google.com/')
  })

  it('includes the GitHub OAuth domain', () => {
    expect(POPUP_ALLOWED_PREFIXES).toContain('https://github.com/login/oauth/')
  })
})

describe('shouldOpenInPopup', () => {
  it('returns true for Firebase auth URLs', () => {
    expect(shouldOpenInPopup('https://dreamboothy.firebaseapp.com/__/auth/handler')).toBe(true)
  })

  it('returns true for checkout URLs', () => {
    expect(shouldOpenInPopup('https://checkout.comfy.org/session/abc123')).toBe(true)
  })

  it('returns true for Google accounts URLs', () => {
    expect(shouldOpenInPopup('https://accounts.google.com/o/oauth2/auth?client_id=abc')).toBe(true)
  })

  it('returns true for GitHub OAuth URLs', () => {
    expect(shouldOpenInPopup('https://github.com/login/oauth/authorize?client_id=abc')).toBe(true)
  })

  it('returns false for unknown URLs', () => {
    expect(shouldOpenInPopup('https://evil.example.com/')).toBe(false)
  })

  it('returns false for partial prefix matches', () => {
    expect(shouldOpenInPopup('https://dreamboothy.firebaseapp.com.evil.com/')).toBe(false)
  })
})

describe('isDirectDownloadUrl', () => {
  it('returns true for .zip URLs', () => {
    expect(isDirectDownloadUrl('https://example.com/models/pack.zip')).toBe(true)
  })

  it('returns true for .safetensors URLs', () => {
    expect(isDirectDownloadUrl('https://huggingface.co/repo/resolve/main/model.safetensors')).toBe(true)
  })

  it('returns true for .gguf URLs', () => {
    expect(isDirectDownloadUrl('https://example.com/weights.gguf')).toBe(true)
  })

  it('returns true for .tar.gz URLs', () => {
    expect(isDirectDownloadUrl('https://example.com/archive.tar.gz')).toBe(true)
  })

  it('returns true regardless of query string', () => {
    expect(isDirectDownloadUrl('https://example.com/file.zip?token=abc&t=1')).toBe(true)
  })

  it('returns true for uppercase extensions', () => {
    expect(isDirectDownloadUrl('https://example.com/PACK.ZIP')).toBe(true)
  })

  it('returns false for HTML pages', () => {
    expect(isDirectDownloadUrl('https://example.com/page.html')).toBe(false)
  })

  it('returns false for paths without an extension', () => {
    expect(isDirectDownloadUrl('https://example.com/download')).toBe(false)
  })

  it('returns false for OAuth callback URLs', () => {
    expect(isDirectDownloadUrl('https://accounts.google.com/o/oauth2/auth?client_id=abc')).toBe(false)
  })

  it('returns false for malformed URLs', () => {
    expect(isDirectDownloadUrl('not a real url')).toBe(false)
    expect(isDirectDownloadUrl('')).toBe(false)
  })

  it('does not match extension-like substrings inside the host', () => {
    expect(isDirectDownloadUrl('https://zip.example.com/page')).toBe(false)
  })
})
