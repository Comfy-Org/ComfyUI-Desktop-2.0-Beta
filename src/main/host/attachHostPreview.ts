import { sourceMap } from '../lib/ipc/shared'
import { getAppVersion } from '../lib/ipc'
import { get as getInstallation } from '../installations'
import type { ComfyWindowEntry } from './registry'
import { hostInstallEvents, isInstallHost } from './registry'
import {
  applyChooserHostTheme,
  CHOOSER_HOST_TITLE_TEXT,
  CHOOSER_HOST_WINDOW_TITLE,
} from './createHostWindow'

const APP_VERSION = getAppVersion()

/**
 * Push an install's identity to a chooser host so the chrome reads as that
 * install while an op runs in place, even though the host stays install-less.
 * No-op when the entry is install-backed, destroyed, or the lookup fails.
 */
export async function applyAttachHostPreview(
  entry: ComfyWindowEntry,
  installationId: string,
): Promise<void> {
  if (entry.window.isDestroyed()) return
  if (isInstallHost(entry)) return
  const installation = await getInstallation(installationId)
  if (!installation) return
  // Re-check after the await: the caller is fire-and-forget, so a fast launch
  // could attach or destroy the window mid-lookup. Without these guards a stale
  // preview would clobber attachInstall's real installationId push.
  if (entry.window.isDestroyed()) return
  if (isInstallHost(entry)) return
  const previewChanged = entry.previewInstallationId !== installationId
  entry.previewInstallationId = installationId
  entry.titleBarText = installation.name
  entry.sourceCategory = sourceMap[installation.sourceId]?.category ?? null
  // Mirror attachInstall's OS-title format so a preview reads identically to
  // a live attach outside the title bar's Vue chrome.
  entry.window.setTitle(`${installation.name} — Comfy Desktop v${APP_VERSION}`)
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
    entry.titleBarView.webContents.send('comfy-titlebar:preview-mode-changed', true)
  }
  // Treat the preview-id flip like an attach for the picker snapshot, so the
  // "Current" pill lights up from the moment the chooser stakes the claim
  // rather than waiting for attachInstall (which doesn't run until port-bind).
  if (previewChanged) hostInstallEvents.emit('changed')
}

/** Revert a chooser host's identity surfaces to the chooser-host defaults
 *  when an op aborts without producing an attach. No-op when no preview. */
export function clearAttachHostPreview(entry: ComfyWindowEntry): void {
  if (entry.previewInstallationId === null) return
  entry.previewInstallationId = null
  if (entry.window.isDestroyed()) {
    // Still emit so picker listeners drop the stale id even though the chrome
    // push paths short-circuit on a destroyed window.
    hostInstallEvents.emit('changed')
    return
  }
  if (isInstallHost(entry)) {
    hostInstallEvents.emit('changed')
    return
  }
  entry.titleBarText = CHOOSER_HOST_TITLE_TEXT
  entry.sourceCategory = null
  entry.window.setTitle(CHOOSER_HOST_WINDOW_TITLE)
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
    entry.titleBarView.webContents.send('comfy-titlebar:preview-mode-changed', false)
  }
  // Preview never touches theme, but keep this so a future identity-tied
  // theme tweak survives the revert.
  applyChooserHostTheme(entry)
  hostInstallEvents.emit('changed')
}
