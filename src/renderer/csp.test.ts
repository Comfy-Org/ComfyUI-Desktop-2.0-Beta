import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function parseCSP(html: string, source: string): Record<string, string> {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
  if (!match) throw new Error(`CSP meta tag not found in ${source}`)
  const directives: Record<string, string> = {}
  for (const part of match[1].split(';')) {
    const trimmed = part.trim()
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx > 0) {
      directives[trimmed.slice(0, spaceIdx)] = trimmed.slice(spaceIdx + 1)
    }
  }
  return directives
}

const RENDERER_FILES = [
  { file: 'index.html', label: 'launcher renderer' },
  { file: 'panel.html', label: 'panel renderer' },
]

describe.each(RENDERER_FILES)('Content-Security-Policy ($label)', ({ file }) => {
  const html = fs.readFileSync(path.resolve(__dirname, file), 'utf-8')
  const csp = parseCSP(html, file)

  it('has a connect-src directive', () => {
    expect(csp['connect-src']).toBeDefined()
  })

  it('allows Datadog telemetry endpoints in connect-src', () => {
    expect(csp['connect-src']).toContain('https://*.datadoghq.com')
    expect(csp['connect-src']).toContain('https://browser-intake-us5-datadoghq.com')
  })

  it('restricts script-src to self only', () => {
    expect(csp['script-src']).toBe("'self'")
  })

  it('restricts default-src to self only', () => {
    expect(csp['default-src']).toBe("'self'")
  })
})
