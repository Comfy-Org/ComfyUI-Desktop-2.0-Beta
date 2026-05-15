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
import { returnFirstInstallHostToDashboard } from './support/devHooks'
import { waitForWebContents } from './support/cdpPages'

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
  // In-place attach guard: the chooser-host BrowserWindow is supposed
  // to flip into the install's host without spawning a fresh one. Snap
  // the live BrowserWindow ids and the count BEFORE the click so the
  // post-launch assertion can prove the same window survived.
  const before = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  await clickInstallTile(ctx.panel, 'ComfyUI')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)

  const after = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return {
      count: wins.length,
      ids: wins.map((w) => w.id),
      comfyHostId: comfyHost?.id ?? null,
    }
  })

  // Same BrowserWindow count: chooser host was reused, no fresh window
  // was spawned (close+open swap path would briefly land at count + 1
  // and then settle back to count, but the comfyHostId would be NEW).
  expect(after.count).toBe(before.count)
  expect(after.comfyHostId).not.toBeNull()
  // The id of the BrowserWindow hosting ComfyUI must be one of the
  // ids that existed BEFORE the click — proving the chooser host
  // flipped in place rather than being closed and replaced.
  expect(before.ids).toContain(after.comfyHostId)
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
      const comfyChild = children.find((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ) as { getBounds(): { x: number; y: number; width: number; height: number }; getVisible(): boolean } | undefined
      if (!comfyChild) continue
      const bounds = comfyChild.getBounds()
      return {
        childCount: children.length,
        allWebContentsViews: children.every((v) => v instanceof WebContentsView),
        bg: win.getBackgroundColor(),
        comfyBounds: bounds,
        comfyVisible: comfyChild.getVisible(),
      }
    }
    return null
  })

  expect(arch, 'ComfyUI BrowserWindow not found among open windows').not.toBeNull()
  expect(arch!.childCount).toBeGreaterThanOrEqual(2)
  expect(arch!.allWebContentsViews).toBe(true)
  expect(arch!.bg.toLowerCase()).toBe('#171717')
  // Regression guard for the chooser-pick in-place attach onto a unique-
  // partition install: rebuildComfyViewIfNeeded swaps entry.comfyView, and
  // a stale closure in layoutViews used to leave the freshly-built view
  // at default 0×0 invisible bounds — ComfyUI would load but never paint.
  expect(arch!.comfyVisible, 'comfyView is hidden').toBe(true)
  expect(arch!.comfyBounds.width, 'comfyView width is 0').toBeGreaterThan(0)
  expect(arch!.comfyBounds.height, 'comfyView height is 0').toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// Return to Dashboard — symmetric undo of in-place attach
// ---------------------------------------------------------------------------

test('return-to-dashboard flips install host in place (same window id) @lifecycle', async () => {
  // Snapshot the live BrowserWindow ids BEFORE the flip so the
  // post-flip assertion can prove the install-backed host was reused
  // as the chooser host instead of being closed and replaced.
  const before = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Trigger the same code path the File menu's "Return to Dashboard"
  // entry runs (popup item handler calls `returnToDashboard(parentEntryId)`).
  const flippedId = await returnFirstInstallHostToDashboard(ctx.app)
  expect(flippedId, 'no install-backed host window found to flip').not.toBeNull()
  expect(before.ids).toContain(flippedId)

  // After the flip the comfyView should no longer be loading a localhost URL
  // (the install was detached and the comfyView navigated to about:blank).
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(false)

  const after = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Same window count (no fresh window) and the flipped id is still alive —
  // proving the install-backed host stayed the same BrowserWindow when it
  // returned to chooser mode.
  expect(after.count).toBe(before.count)
  expect(after.ids).toContain(flippedId)

  // The chooser body should be visible again on the same window. The
  // install-backed PanelApp was destroyed at attach time, so wait for
  // the chooser PanelApp's webContents to be (re-)created by the in-place
  // detach before driving DOM assertions through it.
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)

  // Re-launch ComfyUI from the same chooser host so the subsequent stop
  // test can find a running comfy webContents to close. The host id must
  // STILL be the same one we just flipped (chooser → install in place).
  await clickInstallTile(ctx.panel, 'ComfyUI')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)

  const reattached = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return { count: wins.length, comfyHostId: comfyHost?.id ?? null }
  })
  expect(reattached.count).toBe(before.count)
  expect(reattached.comfyHostId).toBe(flippedId)
})

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

test('stops running ComfyUI by closing its host window @lifecycle', async () => {
  // After launch, the chooser host transforms in place to host the install
  // (the original `panel.html` body is detached). Drive the stop through the
  // BrowserWindow `close()` call instead — the window's close handler tears
  // the comfy process down via the same path the chooser-tile close button
  // would use. Closing the last host window also quits the Electron app,
  // which is why the subsequent poll treats an evaluate failure (app gone)
  // as the terminal "stopped" state.
  const closed = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const hasComfy = win.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      )
      if (hasComfy) {
        win.close()
        return true
      }
    }
    return false
  })
  expect(closed, 'ComfyUI host window not found among open windows').toBe(true)

  await expect.poll(
    async () => {
      try {
        return await comfyFrontendIsLoaded()
      } catch {
        // App was torn down by the close — that's a stronger "stopped" signal
        // than the comfy webContents going away on its own.
        return false
      }
    },
    { timeout: 60_000, intervals: [500] },
  ).toBe(false)
})
