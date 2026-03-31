import { describe, it, expect } from 'vitest'
import { scrubStderr, lastNLines } from './scrubStderr'

describe('scrubStderr', () => {
  it('redacts Windows user paths', () => {
    expect(scrubStderr('C:\\Users\\JohnDoe\\AppData\\foo')).toBe('C:\\Users\\[REDACTED]\\AppData\\foo')
  })

  it('redacts macOS user paths', () => {
    expect(scrubStderr('/Users/alice/Library/foo')).toBe('/Users/[REDACTED]/Library/foo')
  })

  it('redacts Linux user paths', () => {
    expect(scrubStderr('/home/bob/.config/foo')).toBe('/home/[REDACTED]/.config/foo')
  })

  it('redacts OpenAI-style API keys', () => {
    expect(scrubStderr('key is sk-abc123def456ghi789jk')).toBe('key is [REDACTED]')
  })

  it('redacts HuggingFace tokens', () => {
    expect(scrubStderr('hf_AbCdEfGhIjKlMnOpQrSt')).toBe('[REDACTED]')
  })

  it('redacts Bearer tokens', () => {
    expect(scrubStderr('Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe('Bearer [REDACTED]')
  })

  it('redacts URL credentials', () => {
    expect(scrubStderr('https://user:pass123@example.com/repo')).toBe('https://[REDACTED]@example.com/repo')
  })

  it('redacts env var values for API_KEY', () => {
    expect(scrubStderr('API_KEY=mysecretkey123')).toBe('API_KEY=[REDACTED]')
  })

  it('redacts env var values for TOKEN', () => {
    expect(scrubStderr('MY_TOKEN=abc123')).toBe('MY_TOKEN=[REDACTED]')
  })

  it('redacts env var values for SECRET', () => {
    expect(scrubStderr('MY_SECRET=abc123')).toBe('MY_SECRET=[REDACTED]')
  })

  it('redacts env var values for PASSWORD', () => {
    expect(scrubStderr('PASSWORD=abc123')).toBe('PASSWORD=[REDACTED]')
  })

  it('redacts case-insensitive Windows paths', () => {
    expect(scrubStderr('c:\\users\\johndoe\\appdata\\foo')).toBe('c:\\users\\[REDACTED]\\appdata\\foo')
  })

  it('leaves non-sensitive text unchanged', () => {
    expect(scrubStderr('Python 3.11.5 loading module...')).toBe('Python 3.11.5 loading module...')
  })

  it('handles multiple scrub types in one string', () => {
    const input = 'Error at C:\\Users\\JohnDoe\\AppData\\foo with key sk-abc123def456ghi789jk'
    const result = scrubStderr(input)
    expect(result).toContain('C:\\Users\\[REDACTED]\\AppData\\foo')
    expect(result).not.toContain('JohnDoe')
    expect(result).not.toContain('sk-abc123')
  })
})

describe('lastNLines', () => {
  it('returns last 3 lines of a 5-line string', () => {
    const input = 'line1\nline2\nline3\nline4\nline5'
    expect(lastNLines(input, 3)).toBe('line3\nline4\nline5')
  })

  it('returns all lines when n > total lines', () => {
    const input = 'line1\nline2'
    expect(lastNLines(input, 5)).toBe('line1\nline2')
  })

  it('returns empty string for empty input', () => {
    expect(lastNLines('', 3)).toBe('')
  })

  it('handles single line', () => {
    expect(lastNLines('only line', 3)).toBe('only line')
  })
})
