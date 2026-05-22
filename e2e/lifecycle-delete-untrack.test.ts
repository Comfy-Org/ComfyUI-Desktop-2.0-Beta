/**
 * Lifecycle E2E: Untrack vs Delete divergence.
 *
 * Untrack (`runAction(id, 'remove')`) drops the installation record but
 * leaves the install directory on disk intact. Delete (`runAction(id,
 * 'delete')`) removes both the record and the directory.
 *
 * Drives the IPC directly via `panel.evaluate(window.api.runAction…)` to
 * bypass the renderer-side confirm dialogs — the goal here is regression
 * coverage of the action wiring, not of the modal UX (covered separately
 * by the chooser test).
 */

import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'

let ctx: AppContext
let untrackPath: string
let deletePath: string

const UNTRACK_ID = 'inst-untrack-test'
const UNTRACK_NAME = 'Untrack Me'
const DELETE_ID = 'inst-delete-test'
const DELETE_NAME = 'Delete Me'

/** Marker file the delete action requires before touching the dir. Mirrors
 *  `MARKER_FILE` in `src/main/lib/ipc/shared.ts`. */
const MARKER_FILENAME = '.comfyui-desktop-2'

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function tileNames(): Promise<string[]> {
  return ctx.panel.allText(
    '.chooser-tile:not(.chooser-tile-new):not(.chooser-tile-cloud) .chooser-tile-name',
  )
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  untrackPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-untrack-e2e-'))
  deletePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-delete-e2e-'))
  // The delete action gates on a marker file whose contents match the install
  // id (or the literal 'tracked'). Without it the action refuses to touch the
  // directory — same as Untrack would.
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
  // untrackPath is preserved on disk by design (untrack contract); delete
  // already removed deletePath, but force-clean both in case a test failed
  // mid-flow and left either dir behind.
  if (untrackPath) await rm(untrackPath, { recursive: true, force: true })
  if (deletePath) await rm(deletePath, { recursive: true, force: true })
})

test('chooser lists both seeded installs @lifecycle', async () => {
  await ctx.panel.waitFor(
    async () => {
      const names = await tileNames()
      return names.includes(UNTRACK_NAME) && names.includes(DELETE_NAME)
    },
    { timeout: 10_000, message: 'seeded tiles never both rendered in chooser' },
  )
})

test('untrack drops the record but preserves the install directory @lifecycle', async () => {
  const result = await ctx.panel.evaluate<{ ok: boolean; message?: string }>(
    `window.api.runAction(${JSON.stringify(UNTRACK_ID)}, 'remove')`,
  )
  expect(result.ok, `runAction('remove') failed: ${result.message ?? ''}`).toBe(true)

  await ctx.panel.waitFor(
    async () => !(await tileNames()).includes(UNTRACK_NAME),
    { timeout: 10_000, message: 'untracked tile never disappeared from chooser' },
  )
  expect(await pathExists(untrackPath), 'untrack must leave the install directory on disk').toBe(true)
})

test('delete drops the record AND removes the install directory @lifecycle', async () => {
  const result = await ctx.panel.evaluate<{ ok: boolean; message?: string }>(
    `window.api.runAction(${JSON.stringify(DELETE_ID)}, 'delete')`,
  )
  expect(result.ok, `runAction('delete') failed: ${result.message ?? ''}`).toBe(true)

  await ctx.panel.waitFor(
    async () => !(await tileNames()).includes(DELETE_NAME),
    { timeout: 30_000, message: 'deleted tile never disappeared from chooser' },
  )
  await expect
    .poll(() => pathExists(deletePath), { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe(false)
})
