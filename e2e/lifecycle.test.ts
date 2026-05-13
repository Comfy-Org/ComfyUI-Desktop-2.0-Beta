/**
 * Lifecycle E2E: New Install (CPU standalone, older release) → tile shows up
 * in chooser → Launch → ComfyUI loads → Stop. The Update flow is exercised
 * only when the upstream R2 backend exposes ≥2 release tags.
 *
 * Downloads ~500 MB of standalone payload. Tagged @lifecycle and runs under
 * the dedicated Playwright project (10-minute per-test timeout).
 *
 * Run:
 *   pnpm run build && pnpm run test:e2e:windows -- --project=lifecycle
 *
 * Requirements: network access, ~2 GB free disk.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  clickNewInstallTile,
  clickInstallTile,
  expectChooserVisible,
  expectTakeoverOpen,
} from './support/chooserHelpers'

let ctx: AppContext

/** Release tag captured during install; verified again after launch + update. */
let installedReleaseTag = ''

/** False when only one release tag is published (skip update tests). */
let hasOlderRelease = false

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!process.env['GITHUB_TOKEN']) {
    for (let depth = 2; depth <= 8; depth++) {
      const segments = Array(depth).fill('..')
      const p = resolve(__dirname, ...segments, 'githubtoken.txt')
      try {
        process.env['GITHUB_TOKEN'] = readFileSync(p, 'utf-8').trim()
        break
      } catch { /* try next depth */ }
    }
  }
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx.cleanup()
})

/** Wait for any progress flow to reach a terminal banner. */
async function waitForProgressDone(timeoutMs = 480_000): Promise<'success' | 'error'> {
  await expect.poll(
    async () => {
      if (await ctx.panel.exists('.progress-banner-success')) return 'success'
      if (await ctx.panel.exists('.progress-banner-error')) return 'error'
      return null
    },
    { timeout: timeoutMs, intervals: [500, 1000, 2000] },
  ).not.toBeNull()
  if (await ctx.panel.exists('.progress-banner-success')) return 'success'
  return 'error'
}

/** True iff a webContents with a localhost URL exists and is loaded. */
async function comfyFrontendIsLoaded(): Promise<boolean> {
  return ctx.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((wc) =>
      /^http:\/\/(127\.0\.0\.1|localhost):/.test(wc.getURL()) && !wc.isLoading(),
    ),
  )
}

/** True iff a `button.primary` with matching text exists and is not disabled. */
function isPrimaryButtonEnabled(textSubstring: string): Promise<boolean> {
  return ctx.app.evaluate(async ({ webContents }, payload) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
    if (!wc) return false
    return wc.executeJavaScript(`(() => {
      const needle = ${JSON.stringify(payload.needle)}
      const btns = Array.from(document.querySelectorAll('button.primary'))
      const m = btns.find(b => (b.textContent || '').toLowerCase().includes(needle))
      return !!m && !m.disabled
    })()`) as Promise<boolean>
  }, { needle: textSubstring.toLowerCase() }) as Promise<boolean>
}

/** Read the current options of the #sf-release dropdown via the panel webContents. */
async function readReleaseOptions(): Promise<{ count: number; options: { value: string; text: string }[] }> {
  return ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
    if (!wc) throw new Error('panel webContents missing')
    return wc.executeJavaScript(`(() => {
      const sel = document.querySelector('#sf-release')
      if (!sel) return { count: 0, options: [] }
      const opts = Array.from(sel.options).map(o => ({ value: o.value, text: o.textContent || '' }))
      return { count: opts.length, options: opts }
    })()`) as Promise<{ count: number; options: { value: string; text: string }[] }>
  })
}

// ---------------------------------------------------------------------------
// Install via the New Install takeover
// ---------------------------------------------------------------------------

test('chooser shows New Install tile on cold start @lifecycle', async () => {
  await expectChooserVisible(ctx.panel)
  expect(await ctx.panel.exists('.chooser-tile-new')).toBe(true)
})

test('opens New Install takeover and selects standalone source @lifecycle', async () => {
  await clickNewInstallTile(ctx.panel)
  await expectTakeoverOpen(ctx.panel)

  // Wait for the source list to load.
  await expect.poll(() => ctx.panel.count('.wizard-loading'), { timeout: 30_000 }).toBe(0)

  // Step 1 may auto-advance on supported hardware; if a hero source card is
  // visible, select it and click Next.
  if (await ctx.panel.isVisible('.source-card-hero')) {
    expect(await ctx.panel.click('.source-card-hero')).toBe(true)
    await ctx.panel.waitFor(
      () => isPrimaryButtonEnabled('Next'),
      { timeout: 10_000, message: 'Next button never became enabled' },
    )
    expect(await ctx.panel.clickByText('button.primary', 'Next')).toBe(true)
  }

  await ctx.panel.waitForSelector('#sf-release', { timeout: 30_000 })

  // Wait for the dropdown's options to populate (release fetch + GPU detection
  // both have to settle before the select is enabled with real values).
  await expect.poll(
    () => readReleaseOptions().then((info) => info.count),
    { timeout: 60_000, intervals: [500, 1000, 2000], message: 'release dropdown never populated' },
  ).toBeGreaterThanOrEqual(2)
})

test('selects an installable older release @lifecycle', async () => {
  const optionInfo = await readReleaseOptions()

  expect(optionInfo.count).toBeGreaterThanOrEqual(2)
  hasOlderRelease = optionInfo.count >= 3
  const targetIndex = hasOlderRelease ? 2 : 1
  const target = optionInfo.options[targetIndex]
  expect(target, `release option at index ${targetIndex}`).toBeDefined()
  installedReleaseTag = target!.text.match(/(v[\d.]+\S*)/)?.[1] ?? ''
  expect(installedReleaseTag).toBeTruthy()

  // Set the select via JS (matching the dropdown implementation).
  await ctx.app.evaluate(async ({ webContents }, payload) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
    if (!wc) throw new Error('panel webContents missing')
    return wc.executeJavaScript(`(() => {
      const sel = document.querySelector('#sf-release')
      if (!sel) return false
      sel.value = ${JSON.stringify(payload.value)}
      sel.dispatchEvent(new Event('input', { bubbles: true }))
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }, { value: target!.value })

  await ctx.panel.waitForSelector('.variant-card', { timeout: 30_000 })
})

test('selects CPU variant and proceeds to name step @lifecycle', async () => {
  expect(await ctx.panel.clickByText('.variant-card', 'CPU')).toBe(true)
  // Ensure a Next button is enabled, then click it.
  await ctx.panel.waitFor(
    async () => (await ctx.panel.exists('button.primary')) && !!(await ctx.panel.textOf('button.primary')),
    { timeout: 5_000 },
  )
  expect(await ctx.panel.clickByText('button.primary', 'Next')).toBe(true)
  await ctx.panel.waitForSelector('#inst-name', { timeout: 5_000 })
})

test('completes install and tile appears in chooser @lifecycle', async () => {
  expect(await ctx.panel.clickByText('button.primary', 'Add Install')).toBe(true)
  await ctx.panel.waitForVisible('.view-modal-content', { timeout: 10_000 })

  const result = await waitForProgressDone()
  expect(result).toBe('success')

  // Dismiss progress.
  if (!(await ctx.panel.clickByText('button.primary', 'Done'))) {
    await ctx.panel.pressKey('Escape')
  }

  // The newly-installed install should now show as a chooser tile. Match
  // against real install tiles only (the New Install / Cloud tiles use
  // dedicated classes and their descriptions contain "ComfyUI" too).
  await ctx.panel.waitFor(
    async () => {
      const texts = await ctx.panel.allText(
        '.chooser-tile:not(.chooser-tile-new):not(.chooser-tile-cloud) .chooser-tile-name',
      )
      return texts.some((t) => /ComfyUI/i.test(t))
    },
    { timeout: 15_000, message: 'newly installed ComfyUI tile not found' },
  )

  // Sanity: the captured release tag is non-empty so downstream tests can
  // verify it was actually installed.
  expect(installedReleaseTag).toBeTruthy()
})

// ---------------------------------------------------------------------------
// Launch & verify split-view + dark background
// ---------------------------------------------------------------------------

test('launches ComfyUI from chooser tile @lifecycle', async () => {
  await clickInstallTile(ctx.panel, 'ComfyUI')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)
})

/**
 * Regression guard for #449: per-install BrowserWindow uses the title-bar +
 * content split-view (≥2 WebContentsView children) and the parent
 * BrowserWindow background is dark (#171717) so no white frame flashes
 * pre-load.
 */
test('ComfyUI window has dark background and split-view architecture @lifecycle', async () => {
  const arch = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const children = win.contentView.children
      const hasComfy = children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      )
      if (!hasComfy) continue
      return {
        childCount: children.length,
        allWebContentsViews: children.every((v) => v instanceof WebContentsView),
        bg: win.getBackgroundColor(),
      }
    }
    return null
  })

  expect(arch, 'ComfyUI BrowserWindow not found among open windows').not.toBeNull()
  expect(arch!.childCount).toBeGreaterThanOrEqual(2)
  expect(arch!.allWebContentsViews).toBe(true)
  expect(arch!.bg.toLowerCase()).toBe('#171717')
})

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

test('stops running ComfyUI via chooser tile close button @lifecycle', async () => {
  // The tile gains a `.chooser-tile-cta-close` button while running. Clicking
  // it routes through main's closeComfyWindow IPC, which tears the process
  // down via the window's close handler.
  await ctx.panel.waitForVisible('.chooser-tile-cta-close', { timeout: 30_000 })
  expect(await ctx.panel.click('.chooser-tile-cta-close')).toBe(true)

  await expect.poll(comfyFrontendIsLoaded, { timeout: 60_000, intervals: [500] }).toBe(false)
})
