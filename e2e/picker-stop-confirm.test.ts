/**
 * Picker stop-confirm flow regression (issue #582 fix #6).
 *
 * The instance-picker's expanded right pane (`ComfyUISettingsContent`)
 * dispatches REQUIRES_STOPPED actions (Update Now / Migrate / Restore
 * Snapshot / Delete) against an install that's currently running. The
 * bug shipped four interacting symptoms:
 *
 *   1. The stop-confirm modal disappeared mid-interaction — the popup
 *      hosted the modal in its own WebContentsView, which auto-dismisses
 *      on blur, tearing the modal down before the user could resolve it.
 *   2. The title-bar popup geometry visually obscured the panel-side
 *      modal whenever a different surface tried to host the confirm.
 *      Popups are separate OS-level WebContentsViews so CSS z-index
 *      can't lift the panel modal above them.
 *   3. ESC during the stop-confirm closed the wrong layer — the popup
 *      shell / picker view both consumed ESC even when a modal owned
 *      the foreground.
 *   4. The REQUIRES_STOPPED gate had no second guard at the panel-side
 *      forward path, so a renderer bug that fired show-progress without
 *      resolving the popup-side confirm could slip through.
 *
 * The fix routes the stop-confirm out of the popup entirely:
 *
 *   - `useComfyUISettings.runAction` accepts `deferStoppedGuardToHost`
 *     and skips the inline `actionGuard.checkBeforeAction` for the
 *     picker, tagging the emitted `show-progress` with
 *     `requiresStopped: true`.
 *   - The picker forwards the payload through `pickerForwardShowProgress`
 *     → main `comfy-titlepopup:forward-show-progress` → panel
 *     `panel-trigger-overlay { kind: 'picker-show-progress',
 *     requiresStopped }`.
 *   - `useDeepLinkRouter` runs `actionGuard.checkBeforeAction` against
 *     the panel's own `BaseAlert` (stable, not obscured by the popup,
 *     not torn down on popup blur). Cancel aborts the whole chain —
 *     Confirm stops the session then drives the original `apiCall`.
 *   - The popup's ModalDialog + picker ESC handlers defer to a visible
 *     modal so ESC scopes to the dialog instead of collapsing the
 *     picker or closing the popup.
 *
 * Test strategy: drive the production IPC path through the popup
 * bridge, exactly the call `useComfyUISettings.runAction` emits after
 * the fix. We bypass the button click only because rendering a real
 * Update Now CTA requires seeding live release-channel metadata that
 * the standalone source pulls from network — the bridge call is the
 * single chokepoint every Update / Restore / Migrate path goes through,
 * so testing it directly covers every REQUIRES_STOPPED surface the
 * picker exposes.
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
import { byTestId, TID } from './support/testIds'
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
  // Each test starts from a clean popup / IPC counter state so cancel
  // / confirm assertions don't pick up cross-test residue.
  await closeTitlePopupIfOpen(ctx.app)
  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')
  await clearRunningSessions(ctx.app)
})

/**
 * Open the picker popup in expanded mode for INSTALL_ID and resolve
 * once the popup bridge is exposed. The picker auto-dismiss on blur is
 * benign here — every test fires `pickerForwardShowProgress` from
 * inside the popup itself, which keeps focus there until main hides
 * the popup as part of the forward.
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
 * Simulate the picker's expanded right pane emitting the
 * `show-progress` request that `useComfyUISettings.runAction` produces
 * for a REQUIRES_STOPPED action when `deferStoppedGuardToHost` is set
 * (the picker's host prop today). Carries `requiresStopped: true` so
 * the panel-side `useDeepLinkRouter` runs the stop-confirm.
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
      requiresStopped: true,
    })`,
  )
}

test('Cancel on stop-confirm aborts the action and leaves the session running @lifecycle', async () => {
  await seedRunningSession(ctx.app, {
    installationId: INSTALL_ID,
    installationName: INSTALL_NAME,
  })
  await openExpandedPicker()
  await forwardUpdateActionFromPicker()

  // Popup hides as soon as main routes the forward IPC — that's the
  // contract that protects the panel modal from being obscured by the
  // popup's WebContentsView geometry. Wait for it before asserting
  // against the modal so we know we're observing the post-forward
  // state, not a transient overlap.
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  // Panel-side stop-confirm modal appears with the wired test ids —
  // the registry pattern matches dashboardTile / contextMenuItem.
  await ctx.panel.waitForVisible(byTestId(TID.stopInstanceConfirmModal), { timeout: 5_000 })
  expect(await ctx.panel.isVisible(byTestId(TID.stopInstanceConfirmButton))).toBe(true)
  expect(await ctx.panel.isVisible(byTestId(TID.baseAlertCancel))).toBe(true)

  const cancelled = await ctx.panel.click(byTestId(TID.baseAlertCancel))
  expect(cancelled, 'BaseAlert cancel button click dispatched').toBe(true)
  await ctx.panel.waitFor(
    async () => !(await ctx.panel.exists(byTestId(TID.stopInstanceConfirmModal))),
    { timeout: 5_000, message: 'stop-confirm modal never closed after Cancel' },
  )

  // Bug #3 (REQUIRES_STOPPED bypass) guard: Cancel must abort the
  // entire chain — neither stop-comfyui nor run-action may fire after
  // the user dismisses the confirm.
  const stopCalls = await getIpcInvocations(ctx.app, 'stop-comfyui')
  const runCalls = await getIpcInvocations(ctx.app, 'run-action')
  expect(stopCalls, 'stop-comfyui must not be invoked when Cancel is clicked').toEqual([])
  expect(runCalls, 'run-action must not be invoked when Cancel is clicked').toEqual([])
})

test('Confirm stops the session and dispatches the action @lifecycle', async () => {
  await seedRunningSession(ctx.app, {
    installationId: INSTALL_ID,
    installationName: INSTALL_NAME,
  })
  await openExpandedPicker()
  await forwardUpdateActionFromPicker()

  // Popup hides before the modal appears — same contract as the cancel
  // test. Without this, a click on the stop-confirm primary action
  // could race against an open popup geometry and miss.
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  await ctx.panel.waitForVisible(byTestId(TID.stopInstanceConfirmButton), { timeout: 5_000 })
  const confirmed = await ctx.panel.click(byTestId(TID.stopInstanceConfirmButton))
  expect(confirmed, 'stop-confirm primary button click dispatched').toBe(true)

  // Modal must close on confirm — same lifecycle as Cancel. Without
  // this gate the next assertion races against the in-flight resolve.
  await ctx.panel.waitFor(
    async () => !(await ctx.panel.exists(byTestId(TID.stopInstanceConfirmModal))),
    { timeout: 5_000, message: 'stop-confirm modal never closed after Confirm' },
  )

  // The action chain that fires after Confirm:
  //   1. `window.api.stopComfyUI(id)` — `actionGuard.checkBeforeAction`
  //      sends this once the user confirms the stop-running prompt.
  //   2. Internal 500ms settling delay (useActionGuard).
  //   3. `window.api.runAction(id, 'update-comfyui')` — the original
  //      `apiCall` rebuilt panel-side from the picker's forwarded
  //      payload.
  // Poll on both counters rather than asserting in lock-step so the
  // intermediate 500ms wait doesn't introduce timing flake on cold
  // CI runners.
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

  // Bug #4 guard: the run-action invocation must carry the original
  // action id against the original install; the panel must not silently
  // drop the action payload or route a different action while
  // resolving the stop-confirm.
  const runCalls = await getIpcInvocations(ctx.app, 'run-action')
  const recorded = runCalls[0] as { installationId?: string; actionId?: string } | undefined
  expect(recorded, 'run-action invocation recorded').toBeTruthy()
  expect(recorded?.installationId).toBe(INSTALL_ID)
  expect(recorded?.actionId).toBe('update-comfyui')
})
