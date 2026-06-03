/** Stripe checkout origin. Shared so the checkout prefix in
 *  {@link POPUP_ALLOWED_PREFIXES} can't drift from {@link isCheckoutUrl}. */
const CHECKOUT_PREFIX = 'https://checkout.comfy.org/'

/**
 * URLs that are allowed to open in Electron popup windows (e.g. Firebase auth, checkout).
 * These MUST remain present — see allowedPopups.test.ts.
 */
export const POPUP_ALLOWED_PREFIXES = [
  'https://dreamboothy.firebaseapp.com/',
  CHECKOUT_PREFIX,
  'https://accounts.google.com/',
  'https://github.com/login/oauth/',
]

export function shouldOpenInPopup(url: string): boolean {
  return POPUP_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/**
 * Is this the credits-checkout `window.open`? The cloud frontend opens
 * `https://checkout.comfy.org/...`. We open it as a styled child popup
 * and auto-close it on the return redirect — see `isCheckoutReturnUrl`.
 */
export function isCheckoutUrl(url: string): boolean {
  return url.startsWith(CHECKOUT_PREFIX)
}

/**
 * Auto-close predicate for the checkout popup: true once it leaves
 * `checkout.comfy.org` and lands back on a first-party comfy.org page
 * — i.e. the post-payment / cancel return redirect. Without this the
 * popup lingers showing a second copy of the app after payment.
 * Deliberately false for the checkout host itself (mid-flow) and for
 * intermediate Stripe 3DS / bank-ACS hosts (`*.stripe.com`, etc.) so we
 * never close while the user is still paying. The leading-dot
 * `.comfy.org` suffix check defeats the `comfy.org.evil.com` spoof.
 * False on unparseable input.
 */
export function isCheckoutReturnUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host === 'checkout.comfy.org') return false
  return host === 'comfy.org' || host.endsWith('.comfy.org')
}

/**
 * File extensions on a URL's pathname that strongly indicate the
 * target is a download rather than something the user wants to open
 * in the system browser. Used as a fallback when the
 * `setWindowOpenHandler` `disposition` arg is not `'save-to-disk'`
 * (e.g. the cloud renders a `window.open(zipUrl)` without an `<a
 * download>` attribute). Archive + bundled-asset extensions only —
 * deliberately omits `.json`, `.html`, etc. that the user may
 * legitimately want to open in a browser.
 */
const DOWNLOAD_FILE_EXTENSIONS = [
  '.zip',
  '.7z',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.gz',
  '.bz2',
  '.xz',
  '.rar',
  '.dmg',
  '.exe',
  '.msi',
  '.pkg',
  '.deb',
  '.rpm',
  '.appimage',
  '.safetensors',
  '.sft',
  '.ckpt',
  '.bin',
  '.gguf',
  '.pt',
  '.pth',
]

/**
 * Heuristic: does the URL's pathname end in a known archive / binary
 * extension? Used to capture the "Download zip" link on the cloud
 * comfy page when the cloud frontend uses a plain `window.open(url)`
 * (no `<a download>`) — Electron's `setWindowOpenHandler` reports
 * `disposition: 'foreground-tab'` in that case, indistinguishable
 * from a normal external link by disposition alone.
 *
 * Returns false for unparseable URLs so the caller can safely fall
 * through to its default branch.
 */
export function isLikelyDownloadUrl(url: string): boolean {
  let pathname: string
  try {
    pathname = new URL(url).pathname.toLowerCase()
  } catch {
    return false
  }
  return DOWNLOAD_FILE_EXTENSIONS.some((ext) => pathname.endsWith(ext))
}
