/**
 * Lifecycle E2E: synthetic `restart` action.
 *
 * When an install is running, both `DetailModal.bottomActions` and the
 * picker's `useComfyUISettings.pinBottomActions` swap the source-side
 * `launch` action for a synthetic `id: 'restart'` action. Clicking it
 * routes through `useComfyUISettings.runAction`, which sets
 * `isRestart = true` and emits a `picker-show-progress` payload (popup
 * surface) or directly drives the panel's `handleShowProgress`
 * (DetailModal surface). On the panel side, `useDeepLinkRouter`
 * rebuilds the apiCall as `stopAndWaitForExit(id) → runAction('launch')`
 * so the user sees one continuous "Restarting ComfyUI" ProgressModal.
 *
 * This test drives the picker's popup-bridge entry-point (the same IPC
 * shape the expanded-picker Restart click emits) and asserts:
 *   1. `stop-comfyui` IPC fires exactly once (the synthetic restart's
 *      self-stop preamble).
 *   2. `run-action(launch)` fires after the stop completes.
 *   3. No other `run-action` invocations land — the synthetic restart
 *      maps purely to stop+launch, not to a backend 'restart' action.
 *
 * The DetailModal Restart surface uses the same `runAction` codepath
 * (its `isRestart` branch lives in `runAction`'s showProgress block at
 * `useComfyUISettings.ts:478`), so this test covers both surfaces.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  seedRunningSession,
} from './support/devHooks'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-restart-synthetic-test'
const INSTALL_NAME = 'Restart Me'
const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-restart-e2e-'))
  await mkdir(installPath, { recursive: true })
  await writeFile(path.join(installPath, MARKER_FILENAME), INSTALL_ID)

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID,
        name: INSTALL_NAME,
        installPath,
        sourceId: 'standalone',
        status: 'installed',
      },
    ],
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await clearRunningSessions(ctx.app)
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
})

test.beforeEach(async () => {
  await closeTitlePopupIfOpen(ctx.app)
  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')
  await clearRunningSessions(ctx.app)
  // `clearRunningSessions` returns once main has cleared its session
  // map; wait for the `instance-stopped` broadcast to propagate into
  // the panel's `sessionStore` so the next `wasRunning` capture in
  // useDeepLinkRouter doesn't inherit a stale running state.
  await expect
    .poll(
      async () => ctx.panel.evaluate<boolean>(
        `(() => window.__e2eRenderer?.isRunning(${JSON.stringify(INSTALL_ID)}) ?? true)()`,
      ),
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(false)
})

async function openExpandedPicker(): Promise<void> {
  const opened = await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        mode: 'expanded',
        initialTab: 'config',
      })
      return true
    })()`,
  )
  expect(opened).toBe(true)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitFor(
    async () => popup.evaluate<boolean>(
      'typeof window.__comfyTitlePopup?.pickerForwardShowProgress === "function"',
    ),
    { timeout: 10_000, message: 'picker popup bridge never appeared' },
  )
}

/** Forward the same payload the expanded picker's Restart button emits
 *  via `handleSettingsShowProgress` after the user accepts the action's
 *  confirm dialog. `isRestart: true` is the marker the panel uses to
 *  swap in the stop→launch apiCall. */
async function forwardRestartFromPicker(): Promise<void> {
  const popup = titlePopupPage(ctx.app)
  await popup.evaluate<void>(
    `window.__comfyTitlePopup.pickerForwardShowProgress({
      installationId: ${JSON.stringify(INSTALL_ID)},
      actionId: 'restart',
      title: 'Restarting ComfyUI — ' + ${JSON.stringify(INSTALL_NAME)},
      cancellable: false,
      triggersInstanceStart: true,
      opKind: 'launch',
      isRestart: true,
    })`,
  )
}

test('synthetic restart: stop-comfyui + run-action(launch) fire in sequence @lifecycle', async () => {
  await seedRunningSession(ctx.app, {
    installationId: INSTALL_ID,
    installationName: INSTALL_NAME,
  })
  await openExpandedPicker()
  await forwardRestartFromPicker()

  // Popup hides as soon as main routes the forward IPC.
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  // The panel's rebuilt apiCall fires stop-comfyui first, waits for
  // the running broadcast to clear, then runs the launch action.
  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'stop-comfyui')).length, {
      timeout: 5_000,
      intervals: [100, 250],
    })
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'run-action')).length, {
      timeout: 10_000,
      intervals: [200, 500],
    })
    .toBeGreaterThanOrEqual(1)

  // Exactly one stop and one launch — the synthetic restart must NOT
  // dispatch a backend 'restart' action (no such handler exists) and
  // must NOT double-stop (would point at both DetailModal-side and
  // panel-side trying to drive the stop).
  const stopCalls = await getIpcInvocations(ctx.app, 'stop-comfyui') as string[]
  expect(stopCalls.length).toBe(1)
  expect(stopCalls[0]).toBe(INSTALL_ID)

  const runCalls = await getIpcInvocations(ctx.app, 'run-action') as
    { installationId?: string; actionId?: string }[]
  // Only one run-action call — for 'launch'. The synthetic 'restart'
  // id is consumed renderer-side; main never sees it.
  expect(runCalls.length).toBe(1)
  expect(runCalls[0]?.installationId).toBe(INSTALL_ID)
  expect(runCalls[0]?.actionId).toBe('launch')
})
