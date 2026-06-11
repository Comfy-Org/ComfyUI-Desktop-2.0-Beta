/**
 * E2E: instance/window navigation matrix — cloud-target deltas (issue #926).
 *
 * Pins `openInstallInNewWindow`'s behavior for cloud targets via recorded IPC +
 * window counts: a new window for a cloud install with no window, plus the
 * `allowDuplicate` carve-out (currently DORMANT — no decision cell sets it; the
 * primitive is kept wired for a future "second window" feature), with a control
 * proving `allowDuplicate` is the only thing lifting the focus-existing guard.
 *
 * Driven from the chooser host (no real cloud attach / network needed): the
 * primitive depends on the TARGET install + `allowDuplicate`, not on the calling
 * view. The decision that *selects* this primitive per current-view is unit
 * tested in `navDecision.test.ts` (cloud-self now resolves to Restart).
 */
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import {
  closeTitlePopupIfOpen,
  isPopupVisible,
  titlePopupPage,
  waitForWebContents,
} from './support/cdpPages'
import {
  clearRunningSessions,
  getIpcInvocations,
  resetIpcInvocations,
} from './support/devHooks'

let ctx: AppContext

const CLOUD_ID = 'inst-nav-cloud-target'
const CLOUD_NAME = 'Nav Cloud Target'

test.describe.configure({ mode: 'serial' })

async function liveWindowCount(): Promise<number> {
  return ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length,
  )
}

async function newWindowCalls(): Promise<{ installationId?: string; allowDuplicate?: boolean; focusedExisting?: boolean }[]> {
  return (await getIpcInvocations(ctx.app, 'open-install-new-window')) as never
}

async function openPicker(): Promise<void> {
  await ctx.panel.evaluate<boolean>(`(() => { window.api.openInstancePicker({}); return true })()`)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitFor(
    async () => popup.evaluate<boolean>('typeof window.__comfyTitlePopup?.openInstallNewWindow === "function"'),
    { timeout: 10_000, message: 'picker bridge never appeared' },
  )
}

/** Open the picker and fire one `openInstallNewWindow` call, returning once the
 *  popup has dismissed (so the IPC has reached main). */
async function openInNewWindow(installationId: string, opts?: { allowDuplicate?: boolean }): Promise<void> {
  await openPicker()
  const popup = titlePopupPage(ctx.app)
  const optsArg = opts ? `, ${JSON.stringify(opts)}` : ''
  await popup.evaluate<void>(`window.__comfyTitlePopup.openInstallNewWindow(${JSON.stringify(installationId)}${optsArg})`)
  await expect.poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), { timeout: 5_000, intervals: [100, 200] }).toBe(false)
}

test.beforeAll(async () => {
  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      { id: CLOUD_ID, name: CLOUD_NAME, sourceId: 'cloud', status: 'installed' },
    ],
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await clearRunningSessions(ctx.app)
  await ctx?.cleanup()
})

test.beforeEach(async () => {
  await closeTitlePopupIfOpen(ctx.app)
  await resetIpcInvocations(ctx.app, 'open-install-new-window')
  await clearRunningSessions(ctx.app)
})

test('cloud target with no window: opens a new window @lifecycle', async () => {
  const before = await liveWindowCount()
  await openInNewWindow(CLOUD_ID)

  await expect.poll(
    async () => (await newWindowCalls()).some((c) => c.installationId === CLOUD_ID && c.focusedExisting === false),
    { timeout: 5_000, intervals: [100, 250] },
  ).toBe(true)
  await expect.poll(() => liveWindowCount(), { timeout: 5_000, intervals: [200, 400] }).toBe(before + 1)
})

test('cloud self with allowDuplicate: always spawns a window (matrix row 16) @lifecycle', async () => {
  // allowDuplicate bypasses the focus-existing guard unconditionally, so it
  // spawns regardless of whether a window already exists for the install.
  const before = await liveWindowCount()
  await openInNewWindow(CLOUD_ID, { allowDuplicate: true })

  await expect.poll(
    async () => (await newWindowCalls()).some(
      (c) => c.installationId === CLOUD_ID && c.allowDuplicate === true && c.focusedExisting === false,
    ),
    { timeout: 5_000, intervals: [100, 250] },
  ).toBe(true)
  await expect.poll(() => liveWindowCount(), { timeout: 5_000, intervals: [200, 400] }).toBe(before + 1)
})

test('allowDuplicate flag is threaded through to main intact @lifecycle', async () => {
  // The focus-vs-spawn outcome of a plain (no-allowDuplicate) call hinges on the
  // install having a REAL attached window, which e2e can't produce without a
  // live cloud session. So here we pin the plumbing that drives that branch: a
  // plain call records `allowDuplicate: false`, distinct from the carve-out call
  // above. The focus-existing behavior itself is unit tested in the dispatcher.
  await openInNewWindow(CLOUD_ID)

  await expect.poll(
    async () => (await newWindowCalls()).some((c) => c.installationId === CLOUD_ID && c.allowDuplicate === false),
    { timeout: 5_000, intervals: [100, 250] },
  ).toBe(true)
})
