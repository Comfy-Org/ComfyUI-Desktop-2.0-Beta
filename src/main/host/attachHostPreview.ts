import { sourceMap } from '../lib/ipc/shared'
import { getAppVersion } from '../lib/ipc'
import { get as getInstallation } from '../installations'
import type { ComfyWindowEntry } from './registry'
import { isInstallHost } from './registry'
import {
  applyChooserHostTheme,
  CHOOSER_HOST_TITLE_TEXT,
  CHOOSER_HOST_WINDOW_TITLE,
} from './createHostWindow'

const APP_VERSION = getAppVersion()

/**
 * Push an install's identity (title + source category + OS window
 * title + preview-mode flag) to a chooser host so the user can see
 * which install is being acted on while an op runs in place — the
 * host stays install-less but the chrome reads as if it were already
 * that install. The preview-mode flag lets the title-bar renderer
 * surface install-scoped chrome (e.g. the install-type icon) that
 * would otherwise be suppressed on an install-less host.
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
  // OS-level title (taskbar / Alt+Tab / dock) — mirror the install-
  // backed format from `attachInstall` so a preview reads identically
  // to a live attach outside the title bar's Vue chrome.
  entry.window.setTitle(`${installation.name} — Desktop 2.0 v${APP_VERSION}`)
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
    entry.titleBarView.webContents.send('comfy-titlebar:preview-mode-changed', true)
  }
}

/**
 * Revert a chooser host's identity surfaces back to the chooser-host
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
  entry.window.setTitle(CHOOSER_HOST_WINDOW_TITLE)
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:title-changed', entry.titleBarText)
    entry.titleBarView.webContents.send(
      'comfy-titlebar:source-category-changed',
      entry.sourceCategory,
    )
    entry.titleBarView.webContents.send('comfy-titlebar:preview-mode-changed', false)
  }
  // Re-apply the chooser theme too — preview never touched theme (the
  // launcher-theme bg/text stay correct across a preview), but keep
  // the call here so any future identity-tied theme tweak survives the
  // revert.
  applyChooserHostTheme(entry)
}
