/**
 * Lifecycle E2E: picker-driven `update-comfyui` against a stable target
 * where the install is AHEAD of the baseTag (`commitsAhead > 0`) — a
 * downgrade. Asserts the renderer surfaces:
 *
 *   1. `actionData.isDowngrade === true` on the `start-background-op` IPC
 *      payload main reads to drive the op.
 *   2. The picker's inline op-overlay title reads "Downgrading…" (NOT
 *      "Updating…") for the in-flight state — proving the wiring from
 *      action builder → IPC → ComfyUISettingsContent overlay branch.
 *
 * The action itself fails partway through (no real ComfyUI checkout to
 * `git checkout` against) — we don't care, we capture the in-flight
 * overlay copy before the failure lands.
 *
 * No network — the release-cache is populated by a one-shot real
 * check-update against Comfy-Org/ComfyUI, same as
 * `lifecycle-update-check.test.ts`. Adds ~one ls-remote.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { waitForWebContents, titlePopupPage } from './support/cdpPages'
import { getIpcInvocations, resetIpcInvocations } from './support/devHooks'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let stagedInstallPath = ''

const INSTALL_ID = 'inst-downgrade-copy'
const INSTALL_NAME = 'Downgrade Copy Test'
const SEEDED_BASE_TAG = 'v0.3.20'
const SEEDED_COMMIT = 'b'.repeat(40)

interface RunActionResult { ok: boolean; message?: string }

interface StartBackgroundOpInvocation {
  installationId: string
  actionId: string
  actionData?: { isDowngrade?: boolean; channel?: string }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  stagedInstallPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-downgrade-copy-e2e-'))
  // `.git` presence flips `hasGit` in `getDetailSections` — needed so
  // the `update-comfyui` action button materializes in the channel
  // card. The action itself will bail when it tries to `git checkout`
  // against this stub, but the picker has already fired the
  // `start-background-op` IPC by then, which is what we observe.
  await mkdir(path.join(stagedInstallPath, 'ComfyUI', '.git'), { recursive: true })

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID,
        name: INSTALL_NAME,
        installPath: stagedInstallPath,
        sourceId: 'standalone',
        status: 'installed',
        updateChannel: 'stable',
        // `commitsAhead > 0` is the downgrade signal: the install is
        // ahead of its baseTag, so picking stable means rolling back.
        // `updateSections.ts` lines 113 flag isDowngrade on this combo.
        comfyVersion: { commit: SEEDED_COMMIT, baseTag: SEEDED_BASE_TAG, commitsAhead: 5 },
        releaseTag: SEEDED_BASE_TAG,
        variant: 'cpu',
        pythonVersion: '3.12',
      },
    ],
  })
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (stagedInstallPath) await rm(stagedInstallPath, { recursive: true, force: true })
})

test('downgrade — picker fires update-comfyui with isDowngrade=true and overlay says "Downgrading…" @lifecycle', async () => {
  test.setTimeout(120_000)

  // Prime the release cache so the stable card flips `updateAvailable=true`.
  const checkResult = await ctx.panel.evaluate<RunActionResult>(
    `window.api.runAction(${JSON.stringify(INSTALL_ID)}, 'check-update')`,
  )
  expect(checkResult.ok, `check-update failed: ${checkResult.message ?? ''}`).toBe(true)

  await resetIpcInvocations(ctx.app, 'comfy-titlepopup:start-background-op')

  // Open the picker directly on the Update tab.
  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        initialTab: 'update',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  // The "Update Now" CTA on the stable card.
  await popup.waitForSelector(byTestId(TID.updateActionButton('update-comfyui')), { timeout: 60_000 })
  expect(await popup.click(byTestId(TID.updateActionButton('update-comfyui')))).toBe(true)

  // Downgrade confirm message is plain text → BaseAlert path.
  const confirmSelector = '[data-testid="modal-confirm-button"], [data-testid="base-alert-action"]'
  await popup.waitForVisible(confirmSelector, { timeout: 15_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  // (1) IPC payload carries isDowngrade=true. Poll because the
  // start-background-op record lands microseconds after the click.
  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, 'comfy-titlepopup:start-background-op')) as StartBackgroundOpInvocation[],
      { timeout: 10_000, intervals: [100, 250] },
    )
    .toContainEqual(
      expect.objectContaining({
        installationId: INSTALL_ID,
        actionId: 'update-comfyui',
        actionData: expect.objectContaining({ isDowngrade: true }),
      }),
    )

  // (2) The inline overlay's title element reads "Downgrading…" while
  // in flight. Poll because the popup-side render is one microtask
  // after the broadcast. (The actual op will fail soon after — we just
  // need to catch the in-flight render.)
  await expect
    .poll(
      async () =>
        popup.evaluate<string>(
          `document.querySelector('.op-title')?.textContent?.trim() ?? ''`,
        ),
      { timeout: 15_000, intervals: [250, 500] },
    )
    .toMatch(/Downgrading/i)
})
