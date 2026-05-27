/**
 * Lifecycle E2E: file-menu Skip Onboarding entry point.
 *
 * Cold-start drops the user on the first-use consent screen. The
 * title-bar file menu surfaces a Skip Onboarding entry once we're
 * past the locked-down `'consent-lockdown'` mode; here we replay the
 * `comfy-panel:first-use-skip` IPC main fires for that menu item
 * directly into the panel webContents (the popup item handler is
 * exercised separately in titlePopup unit tests).
 *
 * Asserts `completeFirstUseAndDismiss` runs end-to-end:
 *   - persists `firstUseCompleted: true` (one set-setting call)
 *   - drops the first-use takeover and reveals the chooser body
 *   - pushes `'none'` as the host's `firstUseMode`
 */

import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { getIpcInvocations, resetIpcInvocations } from './support/devHooks'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // True cold start — no `firstUseCompleted` seed, so the host opens
  // on the first-use takeover.
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx?.cleanup()
})

test('cold start lands on first-use consent screen @lifecycle', async () => {
  await ctx.panel.waitForVisible('.consent-hero', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="first-use-accept-consent"]')
})

test('Skip Onboarding IPC clears bookkeeping and reveals the chooser @lifecycle', async () => {
  // Reset so the assertions below count only the calls produced by
  // the skip-onboarding IPC (boot already exercised consent-step
  // mounting which pushed `'consent-lockdown'`).
  await resetIpcInvocations(ctx.app, 'set-setting')
  await resetIpcInvocations(ctx.app, 'comfy-window:set-first-use-mode')

  // Replay the IPC the file-menu Skip Onboarding handler fires into
  // the panel renderer (`titlePopup.ts` → `'skip-onboarding'`
  // branch). PanelApp's `useFirstUseChain.onMounted` subscribes via
  // `window.api.onFirstUseSkip` and routes here to
  // `completeFirstUseAndDismiss`.
  await ctx.app.evaluate(({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
    if (!wc) throw new Error('panel webContents not found')
    wc.send('comfy-panel:first-use-skip')
  })

  // Takeover dismisses → chooser body becomes visible. The cloud +
  // new-install tiles are always rendered, so polling the chooser-view
  // selector is enough to confirm the host body unblocked.
  await ctx.panel.waitForVisible('.chooser-view', { timeout: 10_000 })

  // `completeFirstUseAndDismiss` calls `markFirstUseCompleted` then
  // pushes `'none'` as the firstUseMode. set-setting is idempotent
  // (useLauncherPrefs short-circuits when the ref is already true),
  // so this is the single persist call expected from the skip path.
  await expect.poll(
    async () => {
      const calls = await getIpcInvocations(ctx.app, 'set-setting') as Array<{ key: string; value: unknown }>
      return calls.filter((c) => c.key === 'firstUseCompleted' && c.value === true).length
    },
    { timeout: 5_000, intervals: [100, 250] },
  ).toBe(1)

  const modeCalls = await getIpcInvocations(ctx.app, 'comfy-window:set-first-use-mode') as Array<{ mode: string }>
  // The takeover's `onUnmounted` push and the chain's explicit push
  // both land here — either is acceptable, but the FINAL value the
  // host sees must be `'none'` so the file-menu builder stops
  // surfacing the Skip Onboarding entry.
  expect(modeCalls.length).toBeGreaterThan(0)
  expect(modeCalls[modeCalls.length - 1]!.mode).toBe('none')
})
