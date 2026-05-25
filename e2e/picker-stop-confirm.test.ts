/**
 * Picker self-stopping forward flow (issue #582 fix #6 + audit).
 *
 * The instance-picker's expanded right pane (`ComfyUISettingsContent`)
 * dispatches REQUIRES_STOPPED actions (Update Now / Restore Snapshot /
 * Copy / Delete) against an install that's currently running. Earlier
 * the panel-side `useDeepLinkRouter` ran a separate "Stop ComfyUI?"
 * confirm modal in the panel webContents before invoking the apiCall;
 * that surface was the ONLY user-visible stop warning anywhere.
 *
 * The audit replaced that with:
 *   - per-action `confirm` / `prompt` copy augmented with the
 *     `errors.willStopRunning` sentence on the popup side (so the user
 *     sees the warning inside the action's own dialog);
 *   - panel-side `useDeepLinkRouter` rebuilds the apiCall to self-stop
 *     (stop-comfyui → wait → run-action) and, for IN_PLACE_RELAUNCH
 *     ops (`update-comfyui` / `snapshot-restore`), appends a
 *     `run-action('launch')` so the user lands back on a live ComfyUI;
 *   - the standalone stop-confirm modal — and its TID constants — were
 *     removed, so its visual contract is now "must never appear".
 *
 * Test strategy: drive the picker bridge directly, exactly the IPC
 * payload the popup-side `useComfyUISettings.runAction` emits after the
 * user accepts the action's own confirm. The bridge call is the single
 * chokepoint every REQUIRES_STOPPED picker surface goes through (Update
 * / Restore / Copy / Delete), so testing it directly covers every
 * forwarded path. We bypass the button click only because rendering a
 * real Update Now CTA needs seeded live release-channel metadata.
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

const INSTALL_ID = 'inst-picker-stop-confirm-test'
const INSTALL_NAME = 'Stop Me Before Updating'
const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-stop-confirm-e2e-'))
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
  // `clearRunningSessions` returns when main has cleared its
  // `_runningSessions` map, but the resulting `instance-stopped`
  // broadcast still has to round-trip into the panel webContents
  // before the renderer's sessionStore sees the install as stopped.
  // useDeepLinkRouter captures `wasRunning` once at apiCall creation,
  // so polling here is the difference between a clean test and a
  // false-positive self-stop carried over from the previous run.
  await expect
    .poll(
      async () => ctx.panel.evaluate<boolean>(
        `(() => window.__e2eRenderer?.isRunning(${JSON.stringify(INSTALL_ID)}) ?? true)()`,
      ),
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(false)
})

/**
 * Open the picker popup in expanded mode for INSTALL_ID and resolve
 * once the popup bridge is exposed. The picker auto-dismiss on blur is
 * benign here — the bridge call is fired from inside the popup itself,
 * which keeps focus there until main hides the popup as part of the
 * forward.
 */
async function openExpandedPicker(): Promise<void> {
  const opened = await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        mode: 'expanded',
        initialTab: 'update',
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
    { timeout: 10_000, message: 'picker popup bridge never appeared on window.__comfyTitlePopup' },
  )
}

/**
 * Forward an `update-comfyui` show-progress request the way the
 * popup-side `useComfyUISettings.runAction` emits it after the user
 * accepts the augmented confirm dialog. No `requiresStopped` flag —
 * the panel-side `useDeepLinkRouter` derives that from `actionId` plus
 * the live session-store state.
 */
async function forwardUpdateActionFromPicker(): Promise<void> {
  const popup = titlePopupPage(ctx.app)
  await popup.evaluate<void>(
    `window.__comfyTitlePopup.pickerForwardShowProgress({
      installationId: ${JSON.stringify(INSTALL_ID)},
      actionId: 'update-comfyui',
      title: 'Update ComfyUI — ' + ${JSON.stringify(INSTALL_NAME)},
      cancellable: false,
      triggersInstanceStart: false,
      opKind: 'update',
    })`,
  )
}

test('Self-stops the running session and dispatches the action @lifecycle', async () => {
  await seedRunningSession(ctx.app, {
    installationId: INSTALL_ID,
    installationName: INSTALL_NAME,
  })
  await openExpandedPicker()
  await forwardUpdateActionFromPicker()

  // The popup hides as soon as main routes the forward IPC.
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  // The panel rebuilds the apiCall with the self-stop wrapper:
  //   1. `window.api.stopComfyUI(id)` (fires once)
  //   2. wait until the session leaves the running state
  //   3. `window.api.runAction(id, 'update-comfyui')`
  //
  // The IN_PLACE_RELAUNCH append (`run-action('launch')` after a
  // successful update) is gated on `result?.ok !== false`. The test
  // install has no real release-channel metadata so the standalone
  // source-side update-comfyui handler returns `{ ok: false }` and
  // the relaunch is intentionally skipped — covered by the
  // FLOW 1 unit tests instead.
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

  const runCalls = await getIpcInvocations(ctx.app, 'run-action') as
    { installationId?: string; actionId?: string }[]
  expect(runCalls.length).toBeGreaterThanOrEqual(1)
  expect(runCalls[0]?.installationId).toBe(INSTALL_ID)
  expect(runCalls[0]?.actionId).toBe('update-comfyui')

  // stop-comfyui fires exactly once — duplicate stops would point at a
  // regression where both useDeepLinkRouter and the (now-removed)
  // standalone stop-confirm modal tried to stop the session.
  const stopCalls = await getIpcInvocations(ctx.app, 'stop-comfyui')
  expect(stopCalls.length).toBe(1)
})

test('Skips self-stop when the install is NOT running @lifecycle', async () => {
  // Same forward, but no seeded running session. The panel must skip
  // the stop-comfyui step (nothing to stop) AND skip the relaunch (no
  // session was open to begin with — the user wouldn't expect a
  // ComfyUI launch off a stopped install just because they updated it).
  await openExpandedPicker()
  await forwardUpdateActionFromPicker()

  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'run-action')).length, {
      timeout: 10_000,
      intervals: [200, 500],
    })
    .toBeGreaterThanOrEqual(1)

  const stopCalls = await getIpcInvocations(ctx.app, 'stop-comfyui')
  expect(stopCalls.length).toBe(0)

  const runCalls = await getIpcInvocations(ctx.app, 'run-action') as
    { installationId?: string; actionId?: string }[]
  expect(runCalls.length).toBe(1)
  expect(runCalls[0]?.actionId).toBe('update-comfyui')
})
