/**
 * Lifecycle E2E: handleCopyUpdate post-copy update failure branch.
 *
 * `handleCopyUpdate` runs the copy first, then chains an
 * `update-comfyui` against the freshly-copied install. When the update
 * leg fails (here: the seeded source has no ComfyUI/.git so
 * `handleUpdateComfyUI` returns `{ ok: false, message: standalone.updateNoGit }`)
 * the handler must NOT roll back the copy — the user already paid the
 * cost of duplicating the install, so we keep the new install and let
 * them retry the update from it. Pinned contract:
 *
 *   - returns `{ ok: true, newInstallationId, navigate: 'list' }` so
 *     ProgressModal's handleDone still opens the destination,
 *   - new install dir + registry entry survive,
 *   - source dir + marker untouched,
 *   - the user-facing output banner contains both the update failure
 *     and the "retry the update from the new installation" hint.
 */

import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'

let ctx: AppContext
let sourcePath: string

const SOURCE_ID = 'inst-copy-update-fail-source'
const SOURCE_NAME = 'Copy-Update Fail Source'
const COPY_NAME = 'Copy-Update Fail Destination'
const MARKER_FILENAME = '.comfyui-desktop-2'

interface CopyResult {
  ok: boolean
  message?: string
  navigate?: string
  newInstallationId?: string
}

interface InstallationLike {
  id: string
  name: string
  installPath?: string
}

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
  sourcePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-copy-update-fail-e2e-'))
  await mkdir(sourcePath, { recursive: true })
  await writeFile(path.join(sourcePath, MARKER_FILENAME), SOURCE_ID)
  // No ComfyUI/.git inside — that's exactly what makes handleUpdateComfyUI
  // bail with `ok: false`. The copy itself still succeeds (performCopy is
  // dumb-recursive over whatever's in the source dir).

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: SOURCE_ID,
        name: SOURCE_NAME,
        installPath: sourcePath,
        sourceId: 'standalone',
        status: 'installed',
      },
    ],
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (sourcePath) await rm(sourcePath, { recursive: true, force: true })
})

test('copy-update keeps the new install when the chained update fails @ci', async () => {
  // Start capturing comfy-output BEFORE firing the action — the handler
  // emits the failure + retry hint via sendOutput during the update
  // step, and we need to assert both lines reached the renderer.
  await ctx.panel.evaluate<void>(
    `(() => {
      window.__copyUpdateOutput = []
      window.__copyUpdateUnsubscribe = window.api.onComfyOutput((data) => {
        if (data && data.installationId === ${JSON.stringify(SOURCE_ID)}) {
          window.__copyUpdateOutput.push(data.text)
        }
      })
    })()`,
  )

  const result = await ctx.panel.evaluate<CopyResult>(
    `window.api.runAction(${JSON.stringify(SOURCE_ID)}, 'copy-update', { name: ${JSON.stringify(COPY_NAME)} })`,
  )

  await ctx.panel.evaluate<void>(
    `(() => {
      if (typeof window.__copyUpdateUnsubscribe === 'function') window.__copyUpdateUnsubscribe()
    })()`,
  )

  // Contract: copy-update reports overall success even when the update
  // step failed, with the destination install id populated so the
  // renderer-side handleDone can open the new install window.
  expect(result.ok, `runAction('copy-update') failed: ${result.message ?? ''}`).toBe(true)
  expect(result.navigate).toBe('list')
  expect(typeof result.newInstallationId).toBe('string')
  expect(result.newInstallationId).not.toBe(SOURCE_ID)
  const newId = result.newInstallationId!

  // Registry survives the update failure — new install is enumerated
  // alongside the source.
  const installations = await ctx.panel.evaluate<InstallationLike[]>(
    'window.api.getInstallations()',
  )
  const newEntry = installations.find((i) => i.id === newId)
  expect(newEntry, 'new install id missing from registry after copy-update failure').toBeDefined()
  expect(newEntry?.installPath, 'new install must carry an installPath').toBeTruthy()

  const destPath = newEntry!.installPath!
  expect(await pathExists(destPath), `destination dir ${destPath} missing after copy-update`).toBe(true)
  const destMarker = await readFile(path.join(destPath, MARKER_FILENAME), 'utf8')
  expect(destMarker, 'destination marker should carry the new install id').toBe(newId)

  // Source untouched.
  expect(await pathExists(sourcePath)).toBe(true)
  const sourceMarker = await readFile(path.join(sourcePath, MARKER_FILENAME), 'utf8')
  expect(sourceMarker).toBe(SOURCE_ID)

  // Output banner: the user must see BOTH the update failure (so they
  // know something didn't go right) AND the retry hint pointing them at
  // the new install (so they know the copy isn't garbage).
  const outputLines = await ctx.panel.evaluate<string[]>('window.__copyUpdateOutput')
  const joined = outputLines.join('')
  expect(joined, `comfy-output never carried the update-failure marker: ${joined}`).toMatch(/Update/i)
  expect(
    joined,
    `comfy-output missing the retry-from-new-install hint: ${joined}`,
  ).toContain('retry the update from the new installation')

  // Cleanup so reruns start clean.
  await rm(destPath, { recursive: true, force: true })
})
