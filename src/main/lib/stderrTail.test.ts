import { describe, it, expect } from 'vitest'
import { lastNLines, stripAnsi } from './stderrTail'

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\u001B[31mError\u001B[0m')).toBe('Error')
  })

  it('removes multiple escape sequences', () => {
    expect(stripAnsi('\u001B[1m\u001B[32mOK\u001B[0m done')).toBe('OK done')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('no codes here')).toBe('no codes here')
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
