/**
 * URLs that are allowed to open in Electron popup windows (e.g. Firebase auth, checkout).
 * These MUST remain present — see allowedPopups.test.ts.
 */
export const POPUP_ALLOWED_PREFIXES = [
  'https://dreamboothy.firebaseapp.com/',
  'https://checkout.comfy.org/',
  'https://accounts.google.com/',
  'https://github.com/login/oauth/',
]

export function shouldOpenInPopup(url: string): boolean {
  return POPUP_ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))
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
