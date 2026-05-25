/**
 * Global Settings → update-comfyui allowlist regression (issue #582
 * fix #2).
 *
 * The title-bar Global Settings drawer gates install-action IPCs via
 * `GLOBAL_SETTINGS_ALLOWED_ACTIONS` in `src/main/popups/titlePopup.ts`.
 * Before the fix the allowlist carried a bare `'update'` id that no
 * source produces — every click on Update Now returned
 * `{ ok: false, message: "Action 'update' is not available." }` and
 * the popup silently swallowed the result. The fix swapped that for
 * the actual `'update-comfyui'` id the standalone + portable sources
 * emit.
 *
 * This test drives the IPC end-to-end from inside a real Global
 * Settings popup webContents and asserts the action surfaces SOME
 * non-allowlist error path — i.e. it is no longer being short-
 * circuited by the allowlist gate. We do NOT require the action to
 * succeed (the seeded install isn't a real git checkout, so the
 * underlying updater would fail) — only that the rejection message
 * doesn't match the "not available" allowlist shape.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { titlePopupPage, waitForWebContents } from './support/cdpPages'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-global-settings-update-test'
const INSTALL_NAME = 'Global Settings Update Me'
const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-gs-update-e2e-'))
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
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
})

test('update-comfyui survives the Global Settings allowlist gate @lifecycle', async () => {
  // Open the Global Settings drawer (title popup, kind='global-settings').
  await ctx.panel.evaluate<void>('window.api.openGlobalSettings()')

  // Wait for the popup webContents to mount + the global-settings
  // root to render. `comfyTitlePopup.html` is shared by every popup
  // kind (instance-picker / global-settings / waffle / downloads), so
  // the URL match alone doesn't prove which renderer is mounted —
  // wait on the kind-specific bridge marker.
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitFor(
    async () => popup.evaluate<boolean>('typeof window.__comfyTitlePopup?.globalSettingsRunInstallAction === "function"'),
    { timeout: 10_000, message: 'global settings popup bridge never appeared on window.__comfyTitlePopup' },
  )

  // Drive the gated IPC from inside the popup so the
  // `popupEntry.kind === 'global-settings'` precondition is satisfied
  // (the IPC explicitly rejects calls from any other webContents).
  // The popup process exposes the preload bridge under
  // `window.__comfyTitlePopup`, NOT `window.api`. Some popup UIs
  // re-export it as `window.api` after mount, but the bridge global is
  // the only stable hook we can reach pre-mount.
  const result = await popup.evaluate<{ ok: boolean; message?: string }>(
    `window.__comfyTitlePopup.globalSettingsRunInstallAction(${JSON.stringify(INSTALL_ID)}, 'update-comfyui', {})`,
  )

  // The bug we're guarding against produced
  //   { ok: false, message: "Action '<id>' is not available." }
  // verbatim from the GLOBAL_SETTINGS_ALLOWED_ACTIONS gate. The
  // allowlist fix routes `update-comfyui` past the gate into the
  // action dispatcher; for this non-git seeded install the dispatcher
  // typically still resolves to `ok: false`, but the message describes
  // the underlying failure (e.g. "not a git repo", "no remote", ...),
  // not an allowlist rejection.
  //
  // Match the full sentinel shape rather than the literal id so a
  // typo elsewhere in the chain (e.g. if the action id ever flips
  // again) doesn't silently pass: the regression we're guarding
  // against is the gate-level reject for ANY action id, and a
  // "not available" message at any case is the same class of bug.
  expect(result, 'IPC must produce a structured action result').toMatchObject({
    ok: expect.any(Boolean),
  })
  expect(result.message ?? '', 'allowlist must not reject the action id').not.toMatch(/not available/i)
})
