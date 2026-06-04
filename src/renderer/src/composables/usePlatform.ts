// OS-aware copy helpers for the renderer.

export type RendererPlatform = 'mac' | 'windows' | 'linux' | 'unknown'

function normalize(platform: string | undefined | null): RendererPlatform {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  if (platform === 'linux') return 'linux'
  return 'unknown'
}

/** Label for the "open the file's enclosing folder" action, per OS. */
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
