import { describe, expect, it } from 'vitest'
import { scrubAll, scrubPII, scrubSecrets } from './piiScrub'

describe('piiScrub', () => {
  describe('scrubPII', () => {
    it('redacts Windows user directory names', () => {
      expect(scrubPII('Error reading C:\\Users\\alice\\Documents\\foo.txt'))
        .toBe('Error reading C:\\Users\\[REDACTED]\\Documents\\foo.txt')
    })

    it('redacts macOS home directory names', () => {
      expect(scrubPII('open /Users/jane/Library/Application Support/comfy'))
        .toBe('open /Users/[REDACTED]/Library/Application Support/comfy')
    })

    it('redacts Linux home directory names', () => {
      expect(scrubPII('cat /home/bob/.config/comfy/settings.json'))
        .toBe('cat /home/[REDACTED]/.config/comfy/settings.json')
    })

    it('leaves paths without user segments untouched', () => {
      expect(scrubPII('/opt/comfy/bin/comfyui')).toBe('/opt/comfy/bin/comfyui')
    })
  })

  describe('scrubSecrets', () => {
    it('redacts OpenAI keys', () => {
      expect(scrubSecrets('Authorization: sk-abcdef0123456789abcdef0123'))
        .toBe('Authorization: [REDACTED]')
    })

    it('redacts Hugging Face tokens', () => {
      expect(scrubSecrets('token=hf_abcdefghijklmnopqrstuvwx')).toBe('token=[REDACTED]')
    })

    it('redacts Bearer tokens', () => {
      expect(scrubSecrets('Authorization: Bearer abcdef0123456789abcdef0123456789'))
        .toBe('Authorization: Bearer [REDACTED]')
    })

    it('redacts basic-auth credentials in URLs', () => {
      expect(scrubSecrets('git clone https://user:pass@github.com/foo/bar.git'))
        .toBe('git clone https://[REDACTED]@github.com/foo/bar.git')
    })

    it('redacts KEY=, TOKEN=, SECRET=, PASSWORD= assignments', () => {
      expect(scrubSecrets('API_KEY=abc123 OTHER=ok')).toBe('API_KEY=[REDACTED] OTHER=ok')
      expect(scrubSecrets('GITHUB_TOKEN=ghp_xxxx')).toBe('GITHUB_TOKEN=[REDACTED]')
      expect(scrubSecrets('PASSWORD=hunter2')).toBe('PASSWORD=[REDACTED]')
    })
  })

  describe('scrubAll', () => {
    it('applies both PII and secret scrubbing in one pass', () => {
      const input = 'Error at /Users/alice/code: Bearer abcdef0123456789abcdef0123456789'
      const output = scrubAll(input)
      expect(output).toContain('/Users/[REDACTED]/code')
      expect(output).toContain('Bearer [REDACTED]')
      expect(output).not.toContain('alice')
      expect(output).not.toContain('abcdef0123456789')
    })

    it('returns the input unchanged when nothing matches', () => {
      expect(scrubAll('plain telemetry payload with no secrets')).toBe(
        'plain telemetry payload with no secrets',
      )
    })
  })
})
