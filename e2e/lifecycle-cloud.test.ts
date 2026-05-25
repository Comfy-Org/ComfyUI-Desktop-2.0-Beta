/**
 * Lifecycle E2E (cloud branch): cold-start first-use takeover →
 * consent → pick Cloud → host auto-launches the always-seeded Cloud
 * install via `handleFirstUseComplete` → `performChooserLaunch`. The
 * launch action has `showProgress: true`, so the first-use takeover
 * is silently swapped for a connect-progress takeover (Tier 3 → Tier 3)
 * while `waitForUrl` probes `https://cloud.comfy.org/`. Success: the
 * title-bar identity flips out of install-less mode (the same signal
 * `title-bar-hover-gate-comfy-window.test.ts` uses).
 *
 * Network: the cloud launch path runs `waitForUrl(remoteUrl, 15s)`
 * against `https://cloud.comfy.org/`. The probe accepts any HTTP
 * response (status code agnostic), so a reachable endpoint is
 * sufficient — no auth, no specific status required.
 *
 * Tagged @lifecycle to share the dedicated Playwright project's
 * 180-second per-test timeout. No 500 MB download (cloud install is
 * pure remote URL routing), so the suite runs in well under a minute.
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // True cold start: no `firstUseCompleted` seed, so the host opens
  // on the first-use consent screen. The tests below drive through
  // consent + pick-cloud.
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test('cold start lands on first-use consent screen @lifecycle', async () => {
  await ctx.panel.waitForVisible('.consent-hero', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="first-use-accept-consent"]')
})

test('accept consent + pick cloud auto-launches the seeded Cloud install @lifecycle', async () => {
  // Tick the required ToS checkbox; the Get Started CTA stays
  // disabled until `acceptedTos` flips true.
  expect(await ctx.panel.click('[data-testid="first-use-consent-tos"]')).toBe(true)
  await ctx.panel.waitFor(
    async () => ctx.panel.evaluate<boolean>(
      `!document.querySelector('[data-testid="first-use-accept-consent"]').disabled`,
    ),
    { timeout: 5_000, message: 'Get Started never became enabled after ticking ToS' },
  )

  // Accept consent → advance to the cloud-vs-local pick step.
  expect(await ctx.panel.click('[data-testid="first-use-accept-consent"]')).toBe(true)
  await ctx.panel.waitForVisible('[data-testid="first-use-pick-cloud"]', { timeout: 10_000 })

  // Pick Cloud — host marks `firstUseCompleted`, then chains directly
  // into `performChooserLaunch` on the always-seeded Cloud install.
  // The launch action's `showProgress: true` swaps the first-use
  // takeover for the connect-progress takeover (Tier 3 → Tier 3).
  expect(await ctx.panel.click('[data-testid="first-use-pick-cloud"]')).toBe(true)

  // Terminal signal: the title-bar identity flips out of install-less
  // mode once the cloud install attaches reactively over the
  // `comfy-titlebar:installation-id-changed` IPC. Mirrors the assertion
  // in `title-bar-hover-gate-comfy-window.test.ts`. The 30s budget
  // covers the 15s `waitForUrl(remoteUrl)` probe + view attach.
  await expect.poll(
    () => ctx.titleBar.exists('.title-install-pill:not(.is-install-less)'),
    { timeout: 30_000, intervals: [100, 200, 500] },
  ).toBe(true)

  // A comfy WebContentsView eventually points at the remote cloud URL.
  // The pill flips on identity-attach (synchronous over IPC) — the
  // view navigation lags slightly behind, so poll rather than asserting
  // once.
  await expect.poll(
    () => ctx.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((wc) =>
        /^https:\/\/(cloud\.)?comfy\.org\//.test(wc.getURL()),
      ),
    ),
    { timeout: 15_000, intervals: [200, 500, 1000] },
  ).toBe(true)
})
