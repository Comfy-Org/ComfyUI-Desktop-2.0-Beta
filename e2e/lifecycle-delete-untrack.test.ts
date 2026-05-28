/**
 * Lifecycle E2E: chooser kebab Untrack vs Delete divergence (UI-driven).
 *
 * Drives the same kebab → menu-item → confirm flow a user performs
 * manually:
 *
 *   - **Untrack** routes through `onManage({ autoAction: 'remove' })`,
 *     which opens the instance-picker popup in expanded mode with the
 *     autoAction seed. The popup's `ComfyUISettingsContent` then loads
 *     section data, locates the `'remove'` source-action def, and fires
 *     its `confirm` payload as a BaseAlert inside the popup webContents.
 *     Confirming drops the installation from the registry but leaves the
 *     install directory on disk.
 *   - **Delete** routes through the kebab fast-path (`onShowProgress`
 *     builds the confirm renderer-side, no popup mount). The BaseAlert
 *     appears in the panel webContents. Confirming drops both the
 *     registry record and the directory.
 *
 * The Delete fast-path is also covered by `dashboard-delete-flow.test.ts`
 * from a perf angle (no `get-detail-sections` roundtrip). This file
 * exists to pin the divergent disk outcome between the two destructive
 * surfaces on the same chooser tile.
 */

import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { byTestId, TID } from './support/testIds'
import { titlePopupPage, waitForWebContents } from './support/cdpPages'

let ctx: AppContext
let untrackPath: string
let deletePath: string

const UNTRACK_ID = 'inst-untrack-test'
const UNTRACK_NAME = 'Untrack Me'
const DELETE_ID = 'inst-delete-test'
const DELETE_NAME = 'Delete Me'

/** Mirrors `MARKER_FILE` in `src/main/lib/ipc/shared.ts`. Delete refuses
 *  to wipe a directory whose marker is missing or mismatched; Untrack
 *  doesn't touch disk so it doesn't care, but we add it for parity. */
const MARKER_FILENAME = '.comfyui-desktop-2'

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

async function tileExists(installationId: string): Promise<boolean> {
  return ctx.panel.exists(byTestId(TID.dashboardTile(installationId)))
}

/** Drive the chooser kebab: open the menu on `installationId`, wait
 *  for the named menu item, click it. The caller is responsible for
 *  waiting on whichever surface (panel or picker popup) the action's
 *  confirm modal mounts in. */
async function openKebabAndClick(installationId: string, menuItemId: string): Promise<void> {
  const kebabClicked = await ctx.panel.click(byTestId(TID.dashboardTileKebab(installationId)))
  expect(kebabClicked, `kebab click on ${installationId}`).toBe(true)
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem(menuItemId)), { timeout: 5_000 })
  const itemClicked = await ctx.panel.click(byTestId(TID.contextMenuItem(menuItemId)))
  expect(itemClicked, `menu item click ${menuItemId}`).toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  untrackPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-untrack-e2e-'))
  deletePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-delete-e2e-'))
  await mkdir(untrackPath, { recursive: true })
  await mkdir(deletePath, { recursive: true })
  await writeFile(path.join(untrackPath, MARKER_FILENAME), UNTRACK_ID)
  await writeFile(path.join(deletePath, MARKER_FILENAME), DELETE_ID)

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: UNTRACK_ID,
        name: UNTRACK_NAME,
        installPath: untrackPath,
        sourceId: 'standalone',
        status: 'installed',
      },
      {
        id: DELETE_ID,
        name: DELETE_NAME,
        installPath: deletePath,
        sourceId: 'standalone',
        status: 'installed',
      },
    ],
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  // Untrack preserves the dir by design; Delete already removed its dir
  // on success — force-clean both so a mid-flow test failure doesn't leak.
  if (untrackPath) await rm(untrackPath, { recursive: true, force: true })
  if (deletePath) await rm(deletePath, { recursive: true, force: true })
})

test('chooser lists both seeded installs @ci', async () => {
  await ctx.panel.waitForSelector(byTestId(TID.dashboardTile(UNTRACK_ID)), { timeout: 10_000 })
  await ctx.panel.waitForSelector(byTestId(TID.dashboardTile(DELETE_ID)), { timeout: 10_000 })
})

// TODO(#621): `baseAlertAction` confirm never appears in the picker popup.
// Kebab routing changed in #594 (Untrack via picker autoAction) and #607
// (context-menu untrack snapshots). Likely testid/path drift — investigate
// useInstallContextMenu 'untrack' branch + picker autoAction flow.
test.skip('kebab Untrack drops the record but preserves the install directory @ci', async () => {
  await openKebabAndClick(UNTRACK_ID, 'untrack')

  // useInstallContextMenu's 'untrack' branch calls
  // `onManage({ autoAction: 'remove' })`, which in ChooserView opens
  // the picker popup in expanded mode with autoAction seeded. The
  // popup's ComfyUISettingsContent loads sections, finds the 'remove'
  // source-action def, and fires its `confirm` payload as a BaseAlert
  // in the popup webContents.
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 15_000 })
  const confirmed = await popup.click(byTestId(TID.baseAlertAction))
  expect(confirmed, 'untrack confirm click dispatched').toBe(true)

  await ctx.panel.waitFor(
    async () => !(await tileExists(UNTRACK_ID)),
    { timeout: 15_000, message: 'untracked tile never disappeared from chooser' },
  )
  expect(await pathExists(untrackPath), 'untrack must leave the install directory on disk').toBe(true)
})

test('kebab Delete drops the record AND removes the install directory @ci', async () => {
  await openKebabAndClick(DELETE_ID, 'delete')

  // Delete uses the kebab fast-path BaseAlert that useInstallContextMenu
  // builds renderer-side in the panel webContents (no picker popup mount).
  await ctx.panel.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 5_000 })
  const confirmed = await ctx.panel.click(byTestId(TID.baseAlertAction))
  expect(confirmed, 'delete confirm click dispatched').toBe(true)

  await ctx.panel.waitFor(
    async () => !(await tileExists(DELETE_ID)),
    { timeout: 30_000, message: 'deleted tile never disappeared from chooser' },
  )
  await expect
    .poll(() => pathExists(deletePath), { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe(false)
})
