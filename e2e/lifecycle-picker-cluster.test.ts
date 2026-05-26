/**
 * Lifecycle E2E: picker-popup → panel dispatch surfaces.
 *
 * Three IPC paths exposed by the instance-picker popup fan out to the
 * parent host's panel renderer. Each one had no end-to-end coverage
 * before this file:
 *
 *   1. `comfy-titlepopup:pick-install`        — pick a row → focus the
 *      running install (or, for stopped, run `runAction('launch')`).
 *      Tested here with `seedRunningSession` so the focused-running
 *      short-circuit fires `focus-comfy-window` and the test doesn't
 *      need a real ComfyUI process. (audit lifecycle #11)
 *
 *   2. `comfy-titlepopup:open-new-install`    — More-menu's `+ New
 *      Install` row → mounts the new-install Tier 3 takeover on the
 *      current host. (audit lifecycle #12)
 *
 *   3. `comfy-titlepopup:open-install-action` — More-menu's install-
 *      level entries (Open Folder / Copy / Untrack / Delete). Open
 *      Folder is the only non-modal entry, so this file exercises that
 *      one to pin the audit fix that keeps the popup visible for
 *      fire-and-forget actions. (audit lifecycle #13 + annoying #9)
 *
 * Picker popup auto-blurs when focus moves, so the bridge calls fire
 * inside the popup itself — the same pattern `picker-stop-confirm`
 * uses for `pickerForwardShowProgress`.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible, expectTakeoverOpen } from './support/chooserHelpers'
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

const INSTALL_ID = 'inst-picker-cluster-test'
const INSTALL_NAME = 'Picker Cluster Me'
const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-picker-cluster-e2e-'))
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
  await resetIpcInvocations(ctx.app)
  await clearRunningSessions(ctx.app)
})

/** Open the picker popup in expanded mode and wait for its preload
 *  bridge (`window.__comfyTitlePopup`) to be available — same pattern
 *  as `picker-stop-confirm`. */
async function openExpandedPicker(): Promise<void> {
  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        mode: 'expanded',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitFor(
    async () => popup.evaluate<boolean>(
      'typeof window.__comfyTitlePopup?.pickInstall === "function"',
    ),
    { timeout: 10_000, message: 'picker popup bridge never appeared on window.__comfyTitlePopup' },
  )
}

test('pick-install for a running install dismisses the popup and focuses the existing host @lifecycle', async () => {
  // Seed a running session so the chain hits the
  // `performPickerLaunch.focused-running` branch. Without this the
  // panel would attempt a real `runAction('launch')` against a fake
  // standalone install and the test would either hang on a venv
  // detection failure or leak background processes.
  await seedRunningSession(ctx.app, {
    installationId: INSTALL_ID,
    installationName: INSTALL_NAME,
  })

  await openExpandedPicker()

  const popup = titlePopupPage(ctx.app)
  await popup.evaluate<void>(
    `window.__comfyTitlePopup.pickInstall(${JSON.stringify(INSTALL_ID)})`,
  )

  // Main hides the popup at the IPC boundary regardless of the
  // downstream outcome.
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  // The chain reaches `performPickerLaunch` → focused-running →
  // `focusComfyWindow` IPC. This pins the entire pick-install routing
  // (popup → main → panel-trigger-overlay → useDeepLinkRouter →
  // performPickerLaunch) end-to-end; a regression anywhere along the
  // chain drops the IPC.
  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, 'focus-comfy-window')).length,
      { timeout: 5_000, intervals: [100, 250] },
    )
    .toBeGreaterThanOrEqual(1)

  const focusCalls = await getIpcInvocations(ctx.app, 'focus-comfy-window') as
    { installationId?: string }[]
  expect(focusCalls[0]?.installationId).toBe(INSTALL_ID)
})

test('open-new-install dismisses the popup and mounts the new-install takeover @lifecycle', async () => {
  await openExpandedPicker()

  const popup = titlePopupPage(ctx.app)
  await popup.evaluate<void>(
    `window.__comfyTitlePopup.openNewInstall()`,
  )

  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  // The new-install Tier 3 takeover mounts on the chooser host —
  // `expectTakeoverOpen` waits for `.brand-takeover-root`, and the
  // wizard's `.config-shell` is the unique fingerprint distinguishing
  // it from any other takeover.
  await expectTakeoverOpen(ctx.panel)
  await ctx.panel.waitForVisible('.config-shell', { timeout: 10_000 })
})

test('open-install-action with reveal-in-folder keeps the popup open and fires the action @lifecycle', async () => {
  await openExpandedPicker()

  const popup = titlePopupPage(ctx.app)
  // The IPC carries the panel-side composable's menu-item ids (see
  // PanelApp's runInstallActionFromPicker doc) — `reveal-in-folder` is
  // the kebab id that resolves to a `runAction('open-folder')` IPC.
  await popup.evaluate<void>(
    `window.__comfyTitlePopup.openInstallAction(${JSON.stringify(INSTALL_ID)}, 'reveal-in-folder')`,
  )

  // The panel-side dispatch (useInstallContextMenu → runInstantAction-
  // WithAlert) fires `runAction('open-folder')` end-to-end. The picker
  // popup must STAY visible for this fire-and-forget action — Reveal
  // spawns an OS file-manager window and returns the user straight to
  // whatever they were doing, so hiding the popup would discard the
  // picker context for no benefit.
  await expect
    .poll(async () => {
      const calls = (await getIpcInvocations(ctx.app, 'run-action')) as
        { installationId?: string; actionId?: string }[]
      return calls.some((c) => c.installationId === INSTALL_ID && c.actionId === 'open-folder')
    }, { timeout: 5_000, intervals: [100, 250] })
    .toBe(true)

  // The popup must NOT have been hidden by main — assertion intentionally
  // does not poll-then-flip because the regression here would be a
  // close-then-reopen flicker, not a delayed open. Synchronous main-side
  // hideTitlePopup fires before the IPC settles, so by the time the
  // run-action above is observed, any incorrect hide would already be
  // visible.
  expect(
    await isPopupVisible(ctx.app, 'comfyTitlePopup.html'),
    'picker popup should remain open for non-modal Open Folder action',
  ).toBe(true)
})
