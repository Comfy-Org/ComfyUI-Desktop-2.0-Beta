/** Shared so the checkout prefix in {@link POPUP_ALLOWED_PREFIXES} can't drift
 *  from {@link isCheckoutUrl}. */
const CHECKOUT_PREFIX = 'https://checkout.comfy.org/'

/** URLs allowed to open in Electron popup windows. MUST stay present — see
 *  allowedPopups.test.ts. */
export const POPUP_ALLOWED_PREFIXES = [
  'https://dreamboothy.firebaseapp.com/',
  CHECKOUT_PREFIX,
  'https://accounts.google.com/',
  'https://github.com/login/oauth/',
]

export function shouldOpenInPopup(url: string): boolean {
  return POPUP_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
}

/** Is this the credits-checkout `window.open`? Opened as a styled child popup,
 *  auto-closed on the return redirect (see `isCheckoutReturnUrl`). */
export function isCheckoutUrl(url: string): boolean {
  return url.startsWith(CHECKOUT_PREFIX)
}

/**
 * Auto-close predicate for the checkout popup: true once it returns to a
 * first-party comfy.org page. False for the checkout host and intermediate
 * Stripe/bank hosts so we never close mid-payment. The leading-dot suffix
 * check defeats the `comfy.org.evil.com` spoof.
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

/** Extensions indicating a download rather than something to open in the
 *  browser. Archive + bundled-asset only; deliberately omits `.json`/`.html`. */
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

/** Does the URL's pathname end in a known archive/binary extension? Captures
 *  the cloud "Download zip" `window.open(url)`, which Electron can't tell from
 *  a normal link by disposition alone. False on unparseable URLs. */
export function isLikelyDownloadUrl(url: string): boolean {
  let pathname: string
  try {
    pathname = new URL(url).pathname.toLowerCase()
  } catch {
    return false
  }
  return DOWNLOAD_FILE_EXTENSIONS.some((ext) => pathname.endsWith(ext))
}
