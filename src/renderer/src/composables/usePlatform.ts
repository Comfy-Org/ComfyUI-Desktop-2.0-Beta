/**
 * OS-aware copy helpers for the renderer.
 *
 * The host OS is published synchronously by each preload as a static
 * `platform` property (panel/modal: `window.api.platform`; title-bar
 * popup: `window.__comfyTitlePopup.platform`). Both come from
 * `process.platform` in the preload — no IPC, no UA sniffing.
 *
 * Centralised here so any future OS-conditional copy (modifier-key
 * hints, etc.) has a single source of truth and Linux / unknown
 * fallbacks stay consistent across surfaces.
 */

/** Mirrors `NodeJS.Platform` for the values we care about, with
 *  `'unknown'` as the cleanly-undetected fallback. */
export type RendererPlatform = 'mac' | 'windows' | 'linux' | 'unknown'

function normalize(platform: string | undefined | null): RendererPlatform {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'unknown'
}

/**
 * Label for the "open the file's enclosing folder" action.
 *  - mac      → "Show in Finder"
 *  - windows  → "Show in Explorer"
 *  - linux    → "Show in Folder"     (file managers vary on Linux)
 *  - unknown  → "Open Folder"        (cautious neutral fallback)
 */
export function revealInFolderLabel(platform: string | undefined | null): string {
  switch (normalize(platform)) {
    case 'mac':
      return 'Show in Finder'
    case 'windows':
      return 'Show in Explorer'
    case 'linux':
      return 'Show in Folder'
    default:
      return 'Open Folder'
  }
}
