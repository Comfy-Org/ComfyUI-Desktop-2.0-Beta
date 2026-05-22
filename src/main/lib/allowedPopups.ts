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

/** File extensions that should be routed through Electron's session
 *  download flow (native Save dialog via `will-download`) instead of
 *  `shell.openExternal` — which would otherwise hand the URL to the
 *  user's default browser and break the "Comfy is closed off" frame. */
export const DIRECT_DOWNLOAD_EXTENSIONS = [
  '.zip',
  '.7z',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.safetensors',
  '.ckpt',
  '.bin',
  '.gguf',
  '.pt',
  '.pth',
  '.onnx',
]

/** True when the URL's path ends with a known downloadable-asset
 *  extension. Returns false for malformed URLs so callers can safely
 *  fall through to the next branch (typically `shell.openExternal`). */
export function isDirectDownloadUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return DIRECT_DOWNLOAD_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  } catch {
    return false
  }
}
