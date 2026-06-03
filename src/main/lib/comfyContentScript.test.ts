import { describe, expect, it } from 'vitest'
import { getModelDownloadContentScript } from './comfyContentScript'

describe('getModelDownloadContentScript', () => {
  const script = getModelDownloadContentScript()

  it('returns a non-empty string', () => {
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(0)
  })

  it('wraps the script in an IIFE', () => {
    expect(script.startsWith('(function()')).toBe(true)
  })

  it('contains the guard against double injection', () => {
    expect(script).toContain('__comfyDesktop2Injected')
  })

  it('contains the BADGE_TO_DIR mapping with expected directory names', () => {
    expect(script).toContain('BADGE_TO_DIR')
    for (const dir of ['vae', 'diffusion_models', 'text_encoders']) {
      expect(script).toContain(dir)
    }
  })

  it('contains MutationObserver for dialog detection', () => {
    expect(script).toContain('MutationObserver')
  })

  it('guards model download interception behind __comfyDesktop2Remote check', () => {
    expect(script).toContain('__comfyDesktop2Remote')
    // The createElement override should be skipped for remote sessions
    expect(script).toContain('if (!window.__comfyDesktop2Remote)')
  })

  it('routes captured downloads through window.__comfyDesktop2.downloadModel', () => {
    // The Launcher's main-process download manager exposes downloadModel
    // on the preload bridge; the createElement override calls it once it
    // identifies the click target as a model download with a known
    // directory hint from the missing-models scrape cache.
    expect(script).toContain('downloadModel')
  })

  it('contains scrapeErrorsTab function for right side panel missing models', () => {
    expect(script).toContain('scrapeErrorsTab')
  })

  it('detects the properties panel via data-testid', () => {
    expect(script).toContain('[data-testid="properties-panel"]')
  })

  it('extracts directory names from category headers with destructive style', () => {
    expect(script).toContain('text-destructive-background-hover')
  })

  it('tracks errorsTabWasOpen state separately from dialogWasOpen', () => {
    expect(script).toContain('errorsTabWasOpen')
    expect(script).toContain('dialogWasOpen')
  })

  it('only clears modelNameCache when both dialog and errors tab are closed', () => {
    // When dialog closes, it should check errorsTabOpen before clearing
    // When errors tab closes, it should check dialogWasOpen before clearing
    const occurrences = script.split('modelNameCache = {}').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('does not inject the in-page downloads UI', () => {
    // The downloads affordance lives in the title-bar tray (see
    // `TitleBarApp.vue` / `comfyTitlePopup/DownloadsView.vue`). The DOM IDs
    // and the `onDownloadProgress` listener must NOT appear in the
    // injected script — main re-broadcasts download state via
    // `comfy-titlebar:downloads-changed` for the title-bar webContents
    // to consume directly.
    expect(script).not.toContain('__comfy-dl-tab')
    expect(script).not.toContain('__comfy-dl-toasts')
    expect(script).not.toContain('__comfy-dl-cardlist')
    expect(script).not.toContain('__comfy-dl-dock')
    expect(script).not.toContain('onDownloadProgress')
    // Theme scraping was only consumed by the toast UI's color
    // derivation; it has no other consumer in the injected script
    // and is removed alongside the UI.
    expect(script).not.toContain('comfy-menu-bg')
  })

  it('still intercepts remote/cloud workflow outputs for auto-download', () => {
    // The remote/cloud auto-download intercept ferries workflow outputs
    // from a remote ComfyUI server back to the local output directory
    // via the WebSocket message stream.
    expect(script).toContain('downloadAsset')
    expect(script).toContain('window.WebSocket')
  })

  it('auto-downloads 3D outputs (SaveGLB) alongside images/audio/video', () => {
    // SaveGLB emits its results under ui={"3d": [...]} (see
    // ComfyUI/comfy_extras/nodes_save_3d.py). The remote/cloud
    // WebSocket intercept iterates a fixed list of output-dict keys,
    // so "3d" must be in that list or .glb files silently fail to
    // download from cloud/remote sessions (issue #784).
    expect(script).toContain(`['images', 'gifs', 'audio', 'video', '3d']`)
  })
})
