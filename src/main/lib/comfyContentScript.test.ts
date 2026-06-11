/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(script).toContain('if (!window.__comfyDesktop2Remote)')
  })

  it('routes captured downloads through window.__comfyDesktop2.downloadModel', () => {
    expect(script).toContain('downloadModel')
  })

  it('contains scrapeErrorsTab function for right side panel missing models', () => {
    expect(script).toContain('scrapeErrorsTab')
  })

  it('scrapes the missing-model error group via stable data-testid hooks', () => {
    expect(script).toContain('scrapeMissingModelErrorGroup')
    expect(script).toContain('[data-testid="error-group-missing-model"]')
    expect(script).toContain('[data-testid="missing-model-actions"]')
  })

  it('detects the legacy properties panel via data-testid as a fallback', () => {
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
    const occurrences = script.split('modelNameCache = {}').length - 1
    expect(occurrences).toBeGreaterThanOrEqual(2)
  })

  it('does not inject the in-page downloads UI', () => {
    // The downloads affordance lives in the title-bar tray, so these DOM IDs
    // and the progress listener must NOT appear in the injected script.
    expect(script).not.toContain('__comfy-dl-tab')
    expect(script).not.toContain('__comfy-dl-toasts')
    expect(script).not.toContain('__comfy-dl-cardlist')
    expect(script).not.toContain('__comfy-dl-dock')
    expect(script).not.toContain('onDownloadProgress')
    expect(script).not.toContain('comfy-menu-bg')
  })

  it('still intercepts remote/cloud workflow outputs for auto-download', () => {
    expect(script).toContain('downloadAsset')
    expect(script).toContain('window.WebSocket')
  })

  it('auto-downloads 3D outputs (SaveGLB) alongside images/audio/video', () => {
    // SaveGLB emits results under ui={"3d": [...]}, and the WebSocket intercept
    // iterates a fixed key list, so "3d" must be present or .glb files silently
    // fail to download from cloud/remote sessions.
    expect(script).toContain(`['images', 'gifs', 'audio', 'video', '3d']`)
  })
})

describe('missing-model error group interception (behavioral)', () => {
  const origCreateElement = document.createElement.bind(document)

  afterEach(() => {
    document.createElement = origCreateElement
    document.body.innerHTML = ''
    delete (window as unknown as Record<string, unknown>).__comfyDesktop2Injected
    delete (window as unknown as Record<string, unknown>).__comfyDesktop2
  })

  function flushObserver() {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  // Build the right-side-panel missing-model group the way the frontend renders
  // it, but wrap every translatable label in a non-English string. Only the raw
  // directory ("loras") and the model filename (the `title` attr) are read, so a
  // correct mapping here proves the scrape survives i18n.
  function buildLocalizedErrorGroup(directory: string, modelName: string) {
    document.body.innerHTML = `
      <div data-testid="error-group-missing-model">
        <div class="card">
          <div data-testid="missing-model-actions">
            <button data-testid="missing-model-download-all">Alles herunterladen</button>
          </div>
          <div class="category">
            <div class="header"><p><span>${directory} (1)</span></p></div>
            <div class="rows">
              <div class="row">
                <p title="${modelName}">${modelName} (1)</p>
                <button data-testid="missing-model-download" aria-label="Herunterladen ${modelName}">
                  Herunterladen
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `
  }

  it('routes a localized missing-model download with the raw directory', async () => {
    const downloadModel = vi.fn().mockResolvedValue(true)
    ;(window as unknown as Record<string, unknown>).__comfyDesktop2 = {
      downloadModel
    }

    buildLocalizedErrorGroup('loras', 'my_lora.safetensors')

    new Function(getModelDownloadContentScript())()

    // The script only scrapes on mutation; nudge the observer, then let it run.
    document.body.appendChild(document.createElement('div'))
    await flushObserver()

    const link = document.createElement('a')
    link.href = 'https://huggingface.co/repo/resolve/main/my_lora.safetensors'
    link.download = 'my_lora.safetensors'
    link.click()

    expect(downloadModel).toHaveBeenCalledWith(
      'https://huggingface.co/repo/resolve/main/my_lora.safetensors',
      'my_lora.safetensors',
      'loras'
    )
  })
})
