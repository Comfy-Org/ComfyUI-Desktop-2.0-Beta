/**
 * Helpers for the @real lifecycle suite.
 *
 * Every helper in this file drives prerequisites via real DOM clicks /
 * keypresses — never through `__e2e.*`, `window.api.*`, or seeded harness
 * state. See `e2e/AGENTS.md` for the @real contract.
 *
 * The goal: a @real test file's `beforeAll` can call `ensureInstalledAndLaunched(ctx)`
 * and land in a "real user has installed and launched ComfyUI" state without
 * the test itself needing to re-walk the consent → pick-local → Configure
 * → Continue → wait dance.
 *
 * `LIFECYCLE_REUSE_DIR` is the one sanctioned local-dev speedup: when set,
 * `ensureInstalledAndLaunched` detects an existing install on the persisted
 * profile and skips the ~500 MB redownload. CI always runs from a fresh
 * temp dir.
 */

import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect } from '@playwright/test'
import type { AppContext } from '../launchApp'
import { clickInstallTile, expectChooserVisible, openTitleMenu } from './chooserHelpers'
import { waitForWebContents } from './cdpPages'

/** Fully-installed standalone ComfyUI install state. Populated by
 *  `freshInstallStandaloneCpu` (real flow) or `hydrateInstallFromDisk`
 *  (reuse-mode shortcut). */
export interface HydratedInstall {
  id: string
  installPath: string
  comfyUIDir: string
  /** git rev-parse HEAD at hydration time. Empty when the working tree
   *  hasn't been touched yet. */
  installedCommit: string
}

interface InstallationLite {
  id: string
  installPath: string
}

/** True iff a webContents with a localhost URL exists and is loaded —
 *  the canonical "ComfyUI is up" signal across @real tests. */
export async function comfyFrontendIsLoaded(ctx: AppContext): Promise<boolean> {
  return ctx.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((wc) =>
      /^http:\/\/(127\.0\.0\.1|localhost):/.test(wc.getURL()) && !wc.isLoading(),
    ),
  )
}

/** Drive the first-use takeover end-to-end to a fully-installed standalone
 *  ComfyUI on the OLDEST stable release (so downstream update tests always
 *  see "Update available"). On Windows pins the CPU variant; on macOS/Linux
 *  trusts the recommended variant the host detected.
 *
 *  Returns the hydrated install state.
 *
 *  Inputs: real DOM clicks / value-set events on visible form fields.
 *  No `__e2e.*` writes. No `window.api.*` mutations. Reads via
 *  `window.api.getInstallations()` are observation only and allowed. */
export async function freshInstallStandaloneCpu(
  ctx: AppContext,
): Promise<HydratedInstall> {
  // -------------------------------------------------------------
  // Step 1 — first-use start screen
  // -------------------------------------------------------------
  await ctx.panel.waitForVisible('.start-hero', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="first-use-pick-local"]')

  expect(await ctx.panel.click('[data-testid="first-use-pick-local"]')).toBe(true)
  await ctx.panel.waitForVisible('[data-testid="first-use-express-install"]', { timeout: 5_000 })

  // Express defaults to checked on Local pick — uncheck to force the
  // New Install Tier 3 takeover path (covered here) instead of the
  // express short-circuit (covered by FirstUseTakeover.test.ts unit).
  await ctx.panel.evaluate<void>(
    `(() => {
      const wrap = document.querySelector('[data-testid="first-use-express-install"]')
      const cb = wrap && wrap.querySelector('input[type="checkbox"]')
      if (cb && cb.checked) cb.click()
    })()`,
  )

  expect(await ctx.panel.click('[data-testid="first-use-consent-tos"]')).toBe(true)
  await ctx.panel.waitFor(
    async () => ctx.panel.evaluate<boolean>(
      `!document.querySelector('[data-testid="first-use-continue"]').disabled`,
    ),
    { timeout: 5_000, message: 'Continue never became enabled after ticking ToS' },
  )
  expect(await ctx.panel.click('[data-testid="first-use-continue"]')).toBe(true)

  // -------------------------------------------------------------
  // Step 2 — New Install Configure screen
  // -------------------------------------------------------------
  await ctx.panel.waitForVisible('.brand-takeover-root', { timeout: 10_000 })
  await ctx.panel.waitFor(
    async () => ctx.app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
      if (!wc) return false
      return wc.executeJavaScript(`(() => {
        const btn = document.querySelector('.brand-primary.config-continue')
        return !!btn && !btn.disabled
      })()`) as Promise<boolean>
    }),
    { timeout: 60_000, message: 'Continue button never became enabled (form did not pre-fill)' },
  )

  // Expand Advanced + pick the OLDEST stable release so downstream
  // update tests have something to update to.
  expect(await ctx.panel.click('.config-advanced__summary')).toBe(true)
  await ctx.panel.waitForSelector('#source-fields button[role="combobox"]', { timeout: 5_000 })
  expect(await ctx.panel.click('#source-fields button[role="combobox"]')).toBe(true)
  await ctx.panel.waitForVisible('[role="listbox"] [role="option"]', { timeout: 10_000 })
  expect(
    await ctx.panel.evaluate<boolean>(
      `(() => {
        const opts = document.querySelectorAll('[role="listbox"] [role="option"]')
        if (opts.length === 0) return false
        opts[opts.length - 1].click()
        return true
      })()`,
    ),
    'failed to click oldest release option',
  ).toBe(true)

  // Variant re-resolves when release changes — wait for Continue to come back.
  await ctx.panel.waitFor(
    async () => ctx.app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
      if (!wc) return false
      return wc.executeJavaScript(`(() => {
        const btn = document.querySelector('.brand-primary.config-continue')
        return !!btn && !btn.disabled
      })()`) as Promise<boolean>
    }),
    { timeout: 60_000, message: 'Continue never re-enabled after picking oldest release' },
  )

  // CPU pin on Windows only (macOS publishes only mac-mps, linux only GPU variants).
  if (process.platform === 'win32') {
    await ctx.panel.waitForSelector('.brand-variant-row', { timeout: 5_000 })
    expect(
      await ctx.panel.clickByText('.brand-variant-row', 'CPU'),
      'CPU variant row clicked',
    ).toBe(true)
    await ctx.panel.waitFor(
      async () => ctx.panel.evaluate<boolean>(
        `(() => {
          const sel = document.querySelector('.brand-variant-row--selected .brand-variant-row__label')
          return !!sel && /CPU/i.test(sel.textContent || '')
        })()`,
      ),
      { timeout: 5_000, message: 'CPU variant did not become the selected variant row' },
    )
  }

  // -------------------------------------------------------------
  // Step 3 — Continue + wait for install + auto-launch
  // -------------------------------------------------------------
  expect(await ctx.panel.clickByText('.brand-primary', 'Continue')).toBe(true)
  await ctx.panel.waitForVisible('.brand-progress', { timeout: 10_000 })

  // ~500 MB download + extract + auto-launch. Generous timeout because
  // CI runners and dev boxes vary wildly.
  await expect
    .poll(() => comfyFrontendIsLoaded(ctx), { timeout: 480_000, intervals: [1_000, 2_000] })
    .toBe(true)

  return await captureInstallStateFromDisk(ctx)
}

/** Read the live install state off disk (id + path from
 *  `getInstallations`, commit from `git rev-parse`). Used by both
 *  `freshInstallStandaloneCpu` (after a fresh install) and
 *  `hydrateInstallFromDisk` (reuse-mode). */
async function captureInstallStateFromDisk(ctx: AppContext): Promise<HydratedInstall> {
  const installs = await ctx.panel.evaluate<InstallationLite[]>(
    `window.api.getInstallations()`,
  )
  const local = installs.find((i) => typeof i.installPath === 'string' && i.installPath.length > 0)
  if (!local) throw new Error('no local install record found in getInstallations()')

  const comfyUIDir = path.join(local.installPath, 'ComfyUI')
  let installedCommit = ''
  try {
    installedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: comfyUIDir, encoding: 'utf-8', windowsHide: true,
    }).trim()
  } catch { /* partial hydration — git dir may not exist on a half-built profile */ }

  return {
    id: local.id,
    installPath: local.installPath,
    comfyUIDir,
    installedCommit,
  }
}

/** Click the named install tile on the chooser and wait for ComfyUI to load. */
export async function launchComfyByClickingTile(
  ctx: AppContext,
  nameSubstring: string,
): Promise<void> {
  await clickInstallTile(ctx.panel, nameSubstring)
  await expect
    .poll(() => comfyFrontendIsLoaded(ctx), { timeout: 180_000, intervals: [1_000, 2_000] })
    .toBe(true)
}

/** Click the title-bar file-menu (waffle icon) → "Return to Dashboard"
 *  item. Replaces the `__e2e.returnFirstInstallHostToDashboard` backdoor
 *  for @real tests.
 *
 *  Waits for the chooser body to reappear (in-place flip — same window
 *  id, panel.html is rebuilt). */
export async function returnToDashboardViaFileMenu(ctx: AppContext): Promise<void> {
  await openTitleMenu(ctx.titleBar)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')

  // MenuView.vue renders items as `<li class="item"> … <span class="label">{text}</span></li>`.
  // The label string is supplied by `buildTitlePopupMenuItems` in
  // src/main/popups/titlePopup.ts (id: 'return-to-dashboard').
  const popup = (await import('./cdpPages')).titlePopupPage(ctx.app)
  await popup.waitForVisible('.menu .item', { timeout: 5_000 })
  expect(
    await popup.clickByText('.menu .item', 'Return to Dashboard'),
    'Return to Dashboard menu item not found in file menu',
  ).toBe(true)

  // After the flip the comfyView no longer loads a localhost URL and
  // panel.html is rebuilt as the chooser body.
  await expect
    .poll(() => comfyFrontendIsLoaded(ctx), { timeout: 30_000, intervals: [500] })
    .toBe(false)
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)
}

/** Top-level prereq for any @real test that needs a fully-installed
 *  + currently-launched ComfyUI. Hydrates from `LIFECYCLE_REUSE_DIR`
 *  when set (skipping the ~500 MB download), otherwise drives a real
 *  install via `freshInstallStandaloneCpu`.
 *
 *  Always leaves the app in the same observable state on return:
 *  ComfyUI is running, the install-backed panel view is mounted, and
 *  the returned `HydratedInstall` matches what's on disk. */
export async function ensureInstalledAndLaunched(
  ctx: AppContext,
): Promise<HydratedInstall> {
  const reuseDir = process.env['LIFECYCLE_REUSE_DIR']
  if (reuseDir) {
    // Wait briefly for the chooser to mount. On a hydrated profile
    // firstUseCompleted is already true so we land on the chooser body
    // directly. On an empty reuse dir we'd fall through to the install path.
    try {
      await ctx.panel.waitForVisible('.chooser-view', { timeout: 10_000 })
    } catch { /* fresh boot may still be on the first-use takeover */ }

    let hydrated: HydratedInstall | null = null
    try {
      hydrated = await captureInstallStateFromDisk(ctx)
    } catch { /* no install yet — fall through */ }

    if (hydrated) {
      // Hydrated profile: launch the existing install via real click
      // and let the test proceed from a "ComfyUI running" surface.
      await launchComfyByClickingTile(ctx, 'ComfyUI')
      await ensureInstallPanelView(ctx, hydrated.id)
      // Re-capture so installedCommit reflects the post-launch HEAD
      // (no-op on stable installs, useful when the previous run left
      // the working tree at a different commit).
      return await captureInstallStateFromDisk(ctx)
    }
  }

  // Cold start: drive the full first-use install. The install flow
  // auto-launches into ComfyUI as its terminal step.
  const installed = await freshInstallStandaloneCpu(ctx)
  // Auto-launch dropped the panel.html (chooser-pick attach destroys
  // it). Remount via the title bar so subsequent ctx.panel.evaluate
  // calls have a target.
  await ensureInstallPanelView(ctx, installed.id)
  return installed
}

/** Open the install-backed panel view by clicking the title-bar menu's
 *  Settings entry (forces a panel mount via the production path).
 *  After a chooser-pick attach the install-backed PanelApp isn't
 *  mounted until the user touches Settings or the comfy-lifecycle
 *  body — drive that here so subsequent `ctx.panel.evaluate` calls
 *  reach a live webContents.
 *
 *  Falls back to a no-op when the panel is already mounted. */
async function ensureInstallPanelView(ctx: AppContext, _installationId: string): Promise<void> {
  // The cheapest mount trigger is just waiting — production lazy-mounts
  // on first body activation, which happens shortly after ComfyUI loads.
  // If panel.html doesn't appear within a short window, open the file
  // menu and dismiss it — the popup mount path runs the same lazy code
  // that materializes panel.html.
  try {
    await waitForWebContents(ctx.app, 'panel.html', 5_000)
    return
  } catch { /* fall through to the forced mount */ }

  await openTitleMenu(ctx.titleBar)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html', 5_000)
  // Dismiss the popup via Escape inside the popup webContents.
  const popup = (await import('./cdpPages')).titlePopupPage(ctx.app)
  await popup.pressKey('Escape')
  await waitForWebContents(ctx.app, 'panel.html', 10_000)
}
