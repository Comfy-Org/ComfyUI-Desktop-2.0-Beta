import { describe, it, expect } from 'vitest'
import { rewriteCloneUrl, getComfyUIRemoteUrl } from './github-mirror'

describe('rewriteCloneUrl', () => {
  it('returns url unchanged when disabled', () => {
    expect(rewriteCloneUrl('https://github.com/Comfy-Org/ComfyUI', false))
      .toBe('https://github.com/Comfy-Org/ComfyUI')
  })

  it('rewrites Comfy-Org HTTPS url', () => {
    expect(rewriteCloneUrl('https://github.com/Comfy-Org/ComfyUI', true))
      .toBe('https://gitcode.com/gh_mirrors/co/ComfyUI')
  })

  it('rewrites Comfy-Org HTTPS url with .git suffix', () => {
    expect(rewriteCloneUrl('https://github.com/Comfy-Org/ComfyUI.git', true))
      .toBe('https://gitcode.com/gh_mirrors/co/ComfyUI')
  })

  it('rewrites Comfy-Org HTTPS url with trailing slash', () => {
    expect(rewriteCloneUrl('https://github.com/Comfy-Org/ComfyUI/', true))
      .toBe('https://gitcode.com/gh_mirrors/co/ComfyUI')
  })

  it('rewrites Comfy-Org git@ url', () => {
    expect(rewriteCloneUrl('git@github.com:Comfy-Org/ComfyUI.git', true))
      .toBe('https://gitcode.com/gh_mirrors/co/ComfyUI')
  })

  it('rewrites other Comfy-Org repos', () => {
    expect(rewriteCloneUrl('https://github.com/Comfy-Org/ComfyUI_frontend.git', true))
      .toBe('https://gitcode.com/gh_mirrors/co/ComfyUI_frontend')
  })

  it('does not rewrite non-Comfy-Org urls', () => {
    expect(rewriteCloneUrl('https://github.com/SomeUser/SomeRepo.git', true))
      .toBe('https://github.com/SomeUser/SomeRepo.git')
  })

  it('does not rewrite non-GitHub urls', () => {
    expect(rewriteCloneUrl('https://gitlab.com/Comfy-Org/ComfyUI.git', true))
      .toBe('https://gitlab.com/Comfy-Org/ComfyUI.git')
  })
})

describe('getComfyUIRemoteUrl', () => {
  it('returns GitHub url when disabled', () => {
    expect(getComfyUIRemoteUrl(false)).toBe('https://github.com/Comfy-Org/ComfyUI/')
  })

  it('returns gitcode url when enabled', () => {
    expect(getComfyUIRemoteUrl(true)).toBe('https://gitcode.com/gh_mirrors/co/ComfyUI')
  })
})
