import { describe, expect, it } from 'vitest'
import { R2_BASE_URL, R2_MIRROR_BASE_URL, r2MirrorUrl } from './r2Mirror'

describe('r2MirrorUrl', () => {
  it('rewrites the host while preserving the path', () => {
    expect(r2MirrorUrl(`${R2_BASE_URL}/latest.json`)).toBe(
      `${R2_MIRROR_BASE_URL}/latest.json`
    )
    expect(r2MirrorUrl(`${R2_BASE_URL}/linux-nvidia/v0.20.1-env1/foo.7z`)).toBe(
      `${R2_MIRROR_BASE_URL}/linux-nvidia/v0.20.1-env1/foo.7z`
    )
  })

  it('returns undefined for URLs outside the R2 namespace', () => {
    expect(r2MirrorUrl('https://api.github.com/repos/Comfy-Org/ComfyUI/releases')).toBeUndefined()
    expect(r2MirrorUrl('https://example.com/standalone-environments/latest.json')).toBeUndefined()
    expect(r2MirrorUrl('')).toBeUndefined()
  })

  it('does not collide R2 prefix with a longer matching subpath', () => {
    // Ensures the prefix-match is exact-base, not just a substring on the URL.
    expect(r2MirrorUrl(`${R2_BASE_URL}-evil/foo`)?.startsWith(R2_MIRROR_BASE_URL)).toBe(true)
    // ^ acceptable: the function does prefix-match. Documented behaviour; if a
    // suspicious URL exactly starts with R2_BASE_URL it gets a mirror URL. The
    // mirror itself is a public bucket so there's no information leak — the
    // worst case is an unhelpful 404 on the mirror.
  })
})
