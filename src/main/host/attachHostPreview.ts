import { sourceMap } from '../lib/ipc/shared'
import { get as getInstallation } from '../installations'
import type { ComfyWindowEntry } from './registry'
import { isInstallHost } from './registry'
import { applyChooserHostTheme, CHOOSER_HOST_TITLE_TEXT } from './createHostWindow'

/**
 * Push an install's identity (title + source category) to a chooser
 * host's title bar so the user can see which install is being acted
 * on while an op runs in place — the host stays install-less but the
 * chrome reads as if it were already that install.
 *
 * No-op when the entry is install-backed (real attach owns identity)
 * or destroyed, or when the install lookup fails.
 */
export async function applyAttachHostPreview(
  entry: ComfyWindowEntry,
  installationId: string,
): Promise<void> {
  if (entry.window.isDestroyed()) return
  if (isInstallHost(entry)) return
  const installation = await getInstallation(installationId)
  if (!installation) return
  entry.previewInstallationId = installationId
  entry.titleBarText = installation.name
  entry.sourceCategory = sourceMap[installation.sourceId]?.category ?? null
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
  }
}

/**
 * Revert a chooser host's title bar identity back to the chooser-host
 * defaults. Called when the op aborts without producing an attach
 * (cancel / error / dismiss) so the user doesn't keep seeing the
 * previous install's chrome on a host that's clearly back at the
 * dashboard. No-op when no preview is active.
 */
export function clearAttachHostPreview(entry: ComfyWindowEntry): void {
  if (entry.previewInstallationId === null) return
  entry.previewInstallationId = null
  if (entry.window.isDestroyed()) return
  if (isInstallHost(entry)) return
  entry.titleBarText = CHOOSER_HOST_TITLE_TEXT
  entry.sourceCategory = null
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
  }
  // Re-apply the chooser theme too — preview never touched theme (the
  // launcher-theme bg/text stay correct across a preview), but keep
  // the call here so any future identity-tied theme tweak survives the
  // revert.
  applyChooserHostTheme(entry)
}
