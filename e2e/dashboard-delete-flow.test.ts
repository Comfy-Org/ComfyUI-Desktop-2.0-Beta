/**
 * Dashboard Delete fast-path E2E (regression for issue #582 fix #4).
 *
 * Drives the full chooser-kebab → Delete confirm → ProgressModal →
 * directory removed flow and asserts:
 *
 *   1. The confirm modal renders quickly after Delete is clicked
 *      (no perceptible stall while a `get-detail-sections` payload is
 *      rebuilt). The bug shipped a ~2s freeze on Windows because the
 *      composable round-tripped through `get-detail-sections` just to
 *      look up the `deleteAction()` shape; the fast path bypasses it.
 *   2. `get-detail-sections` is NOT invoked during the Delete dispatch
 *      — asserted via the test-only `__e2e.getIpcInvocations()`
 *      counter so a future regression that re-introduces the
 *      roundtrip fails this test rather than re-introducing the
 *      latency.
 *   3. The install directory is gone from disk after Confirm, and the
 *      tile disappears from the chooser.
 */

import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { byTestId, TID } from './support/testIds'
import { getIpcInvocations, resetIpcInvocations } from './support/devHooks'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-dashboard-delete-test'
const INSTALL_NAME = 'Delete Fast-Path Me'

/** Mirrors `MARKER_FILE` in `src/main/lib/ipc/shared.ts`. The delete
 *  action refuses to touch a directory whose marker file is missing. */
const MARKER_FILENAME = '.comfyui-desktop-2'

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-dash-delete-e2e-'))
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

test('chooser shows the seeded tile @lifecycle', async () => {
  await ctx.panel.waitForSelector(byTestId(TID.dashboardTile(INSTALL_ID)), { timeout: 10_000 })
  expect(await ctx.panel.textOf(`${byTestId(TID.dashboardTile(INSTALL_ID))} .chooser-tile-name`)).toBe(INSTALL_NAME)
})

test('Delete from kebab opens confirm without invoking get-detail-sections @lifecycle', async () => {
  // Clear any cumulative invocation history so the assertion measures
  // only what fires during the Delete dispatch itself.
  await resetIpcInvocations(ctx.app, 'get-detail-sections')

  // Open the kebab menu on the seeded tile.
  const kebabClicked = await ctx.panel.click(byTestId(TID.dashboardTileKebab(INSTALL_ID)))
  expect(kebabClicked, 'kebab button click dispatched').toBe(true)

  // The shared ContextMenu portals to <body>; its Delete item carries
  // a `context-menu-item-delete` test id.
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem('delete')), { timeout: 5_000 })
  const deleteClicked = await ctx.panel.click(byTestId(TID.contextMenuItem('delete')))
  expect(deleteClicked, 'delete menu item click dispatched').toBe(true)

  // The confirm modal must appear — it's a `BaseAlert` simple-confirm.
  await ctx.panel.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 5_000 })

  // Fast-path assertion: the Delete dispatch must NOT have invoked the
  // `get-detail-sections` IPC. The bug we're guarding against
  // re-introduces a roundtrip there to look up the action's confirm
  // payload, costing ~2s on Windows before the modal can paint.
  const invocations = await getIpcInvocations(ctx.app, 'get-detail-sections')
  expect(invocations, 'Delete dispatch must not call get-detail-sections').toEqual([])
})

test('Confirm removes the install directory and tile @lifecycle', async () => {
  // Confirm the delete via the BaseAlert primary button.
  const confirmClicked = await ctx.panel.click(byTestId(TID.baseAlertAction))
  expect(confirmClicked, 'confirm button click dispatched').toBe(true)

  // Tile disappears from the chooser once the action completes.
  await ctx.panel.waitFor(
    async () => !(await ctx.panel.exists(byTestId(TID.dashboardTile(INSTALL_ID)))),
    { timeout: 30_000, message: 'deleted tile never disappeared from chooser' },
  )

  // Install directory was removed on disk.
  await expect
    .poll(() => pathExists(installPath), { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe(false)
})
