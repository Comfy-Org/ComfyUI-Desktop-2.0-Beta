/**
 * Lifecycle E2E: dismiss-error from the chooser tile kebab.
 *
 * Drives the `useInstallContextMenu.triggerAction('dismiss-error', inst)`
 * path end-to-end. The kebab grows a `Dismiss error` item when
 * `sessionStore.errorInstances` carries an entry for the install (set
 * by `sessionStore.init`'s `onComfyExited` listener on a real crashed
 * exit, or by a failed `apiCall` settling through `progressStore`).
 *
 * Asserts:
 *   1. With an error seeded, the kebab menu surfaces a
 *      `Dismiss error` item.
 *   2. Clicking it clears `sessionStore.errorInstances[id]`.
 *   3. Re-opening the kebab no longer shows the item — i.e. the
 *      menu was rebuilt against the cleared store, not stale state.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-dismiss-error-test'
const INSTALL_NAME = 'Dismiss Error Me'
const MARKER_FILENAME = '.comfyui-desktop-2'
const ERROR_MESSAGE = 'Simulated crash for dismiss-error e2e'

async function hasErrorInstance(): Promise<boolean> {
  return ctx.panel.evaluate<boolean>(
    `window.__e2eRenderer.hasErrorInstance(${JSON.stringify(INSTALL_ID)})`,
  )
}

async function openKebab(): Promise<void> {
  const clicked = await ctx.panel.click(byTestId(TID.dashboardTileKebab(INSTALL_ID)))
  expect(clicked, 'kebab button click dispatched').toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-dismiss-error-e2e-'))
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
  await ctx.panel.waitForSelector(byTestId(TID.dashboardTile(INSTALL_ID)), { timeout: 10_000 })
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
})

test('Dismiss error from the kebab clears the error instance @ci', async () => {
  // Seed an error directly into the renderer-side sessionStore so the
  // kebab grows its Dismiss-error item without needing to drive a real
  // failing op first. The kebab item visibility tracks
  // `sessionStore.errorInstances.has(id)` (see `useInstallContextMenu`
  // `getMenuItems`).
  await ctx.panel.evaluate<void>(
    `window.__e2eRenderer.seedErrorInstance({
      installationId: ${JSON.stringify(INSTALL_ID)},
      installationName: ${JSON.stringify(INSTALL_NAME)},
      message: ${JSON.stringify(ERROR_MESSAGE)},
    })`,
  )
  expect(await hasErrorInstance(), 'seedErrorInstance did not populate the store').toBe(true)

  await openKebab()
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem('dismiss-error')), { timeout: 5_000 })

  const dismissClicked = await ctx.panel.click(byTestId(TID.contextMenuItem('dismiss-error')))
  expect(dismissClicked, 'dismiss-error menu item click dispatched').toBe(true)

  await expect
    .poll(hasErrorInstance, { timeout: 5_000, intervals: [100, 200] })
    .toBe(false)
})

test('Dismiss-error item is gone from the kebab after clearing @ci', async () => {
  // The menu items are rebuilt on every open via `getMenuItems(inst)`;
  // re-opening proves the item really disappears (not just hidden in
  // a stale prior menu instance) once the store no longer carries an
  // error for this install.
  await openKebab()
  // Wait for the menu to actually mount — Manage is unconditional.
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem('manage')), { timeout: 5_000 })
  expect(
    await ctx.panel.exists(byTestId(TID.contextMenuItem('dismiss-error'))),
    'dismiss-error item should not appear after the error was cleared',
  ).toBe(false)
})
