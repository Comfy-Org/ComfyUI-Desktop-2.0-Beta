import { describe, expect, it } from 'vitest'

import {
  buildCopyLinkBannerScript,
  buildRemoveCopyLinkBannerScript,
  COPY_LINK_BANNER_ID,
  OPEN_LINK_SENTINEL,
  type CopyLinkBannerLabels,
} from './copyLinkBanner'

const labels: CopyLinkBannerLabels = {
  message: 'We opened your browser to sign in. Didn’t open?',
  copy: 'Copy link',
  copied: 'Copied',
  openAgain: 'Open again',
  dismiss: 'Dismiss',
}

const url = 'http://localhost:9876/?provider=google.com&n=abc123'

describe('buildCopyLinkBannerScript', () => {
  it('embeds the login URL verbatim (JSON-escaped)', () => {
    const script = buildCopyLinkBannerScript(url, labels)
    expect(script).toContain(JSON.stringify(url))
  })

  it('dedupes on a repeat injection via getElementById', () => {
    const script = buildCopyLinkBannerScript(url, labels)
    expect(script).toContain('getElementById')
    expect(script).toContain(JSON.stringify(COPY_LINK_BANNER_ID))
  })

  it('emits only the Open-again sentinel (copy never reaches main)', () => {
    const script = buildCopyLinkBannerScript(url, labels)
    expect(script).toContain(JSON.stringify(OPEN_LINK_SENTINEL))
    // Copy is in-page only — no console sentinel, so a remote page can't
    // drive a no-gesture clipboard write.
    expect(script).not.toContain('__comfyCopyLoginLink')
  })

  it('copies in-page with a clipboard primary and execCommand fallback', () => {
    const script = buildCopyLinkBannerScript(url, labels)
    expect(script).toContain('navigator.clipboard')
    expect(script).toContain("execCommand('copy')")
  })

  it('renders Lucide icons and swaps copy → check on success', () => {
    const script = buildCopyLinkBannerScript(url, labels)
    // Lucide check + external-link path data, and the copy → tick swap.
    expect(script).toContain('M20 6 9 17l-5-5') // check
    expect(script).toContain('M15 3h6v6') // external-link
    expect(script).toContain('ICON_TICK')
    expect(script).toContain('ICON_COPY')
  })

  it('is parseable as JavaScript', () => {
    const script = buildCopyLinkBannerScript(url, labels)
    // `Function` surfaces syntax errors without executing — DOM is not in
    // scope but a clean parse is enough to guarantee no script breakage.
    expect(() => new Function(script)).not.toThrow()
  })

  it('escapes hostile URLs and labels without breaking the script', () => {
    const tricky = 'http://x/?q="; alert(1); //</script>'
    const hostileLabels: CopyLinkBannerLabels = {
      ...labels,
      message: '"; document.title="x"; //',
    }
    const script = buildCopyLinkBannerScript(tricky, hostileLabels)
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain(JSON.stringify(tricky))
  })
})

describe('buildRemoveCopyLinkBannerScript', () => {
  it('is parseable and tears down the node + observer', () => {
    const script = buildRemoveCopyLinkBannerScript()
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain(JSON.stringify(COPY_LINK_BANNER_ID))
    expect(script).toContain('disconnect()')
  })
})
