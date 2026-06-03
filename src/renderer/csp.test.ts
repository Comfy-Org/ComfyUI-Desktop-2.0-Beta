import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function parseCSP(html: string): Record<string, string> {
  const match = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)
  if (!match) throw new Error('CSP meta tag not found in html')
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

function readHtml(filename: string): string {
  return fs.readFileSync(path.resolve(__dirname, filename), 'utf-8')
}

const TELEMETRY_RENDERER_HTMLS = ['panel.html', 'comfyTitleBar.html'] as const
const NON_TELEMETRY_RENDERER_HTMLS = [
  'comfyTitlePopup.html',
  'comfyTitleTooltip.html',
  'comfySystemModal.html',
] as const

describe('Content-Security-Policy: panel.html', () => {
  const csp = parseCSP(readHtml('panel.html'))

  it('has a connect-src directive', () => {
    expect(csp['connect-src']).toBeDefined()
  })

  it('allows Datadog telemetry endpoints in connect-src', () => {
    expect(csp['connect-src']).toContain('https://*.datadoghq.com')
    expect(csp['connect-src']).toContain('https://browser-intake-us5-datadoghq.com')
  })

  it('allows PostHog telemetry endpoints in connect-src', () => {
    expect(csp['connect-src']).toContain('https://*.posthog.com')
  })

  it('restricts script-src to self only', () => {
    expect(csp['script-src']).toBe("'self'")
  })

  it('restricts default-src to self only', () => {
    expect(csp['default-src']).toBe("'self'")
  })

  it('allows the typeform feedback origin in frame-src (Send Feedback modal)', () => {
    expect(csp['frame-src']).toBe('https://form.typeform.com')
  })
})

describe.each(TELEMETRY_RENDERER_HTMLS)(
  'Content-Security-Policy: telemetry endpoints in %s',
  (file) => {
    const csp = parseCSP(readHtml(file))

    it('allows Datadog RUM intake', () => {
      expect(csp['connect-src']).toContain('https://*.datadoghq.com')
      expect(csp['connect-src']).toContain('https://browser-intake-us5-datadoghq.com')
    })

    it('allows PostHog Browser intake', () => {
      expect(csp['connect-src']).toContain('https://*.posthog.com')
    })

    it('restricts script-src to self', () => {
      expect(csp['script-src']).toBe("'self'")
    })
  },
)

describe.each(NON_TELEMETRY_RENDERER_HTMLS)(
  'Content-Security-Policy: telemetry endpoints intentionally absent from %s',
  (file) => {
    const csp = parseCSP(readHtml(file))

    // The title-bar dropdown popup is a transient window that does NOT
    // initialise Datadog/PostHog (see comfyTitlePopup/main.ts). Keeping
    // the CSP narrow here documents and enforces that decision — adding
    // a renderer-side telemetry SDK to this surface would also need a
    // CSP loosening, so requiring the change in both places is a useful
    // tripwire.
    it('does NOT include Datadog endpoints', () => {
      expect(csp['connect-src']).not.toContain('datadoghq.com')
    })

    it('does NOT include PostHog endpoints', () => {
      expect(csp['connect-src']).not.toContain('posthog.com')
    })
  },
)
