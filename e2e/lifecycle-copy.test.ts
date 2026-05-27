/**
 * Lifecycle E2E: plain Copy action (no chained update).
 *
 * `handleCopy` is the only copy-family handler that has no chained
 * follow-up — `handleCopyUpdate` and `handleReleaseUpdate` both wrap
 * `performCopy` with an update step on top, and both already have
 * lifecycle coverage. Plain copy was the missing piece: nothing pinned
 * the contract that:
 *
 *   - `runAction(id, 'copy', { name })` returns `{ ok: true,
 *     newInstallationId, navigate: 'list' }`,
 *   - the destination directory exists with a fresh MARKER_FILE
 *     containing the new install id,
 *   - the new id is enumerated by `getInstallations`,
 *   - the source directory + its marker are untouched.
 *
 * Drives the IPC directly via `panel.evaluate(...)` so this stays focused
 * on the handler — the renderer-side `handleDone` →
 * `open-install-window` branch is already covered by
 * `copy-update-destination.test.ts`.
 */

import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'

let ctx: AppContext
let sourcePath: string

const SOURCE_ID = 'inst-copy-plain-source'
const SOURCE_NAME = 'Plain Copy Source'
const COPY_NAME = 'Plain Copy Destination'
const EXTRA_FILENAME = 'workflow.json'
const EXTRA_CONTENTS = '{"copy":"me"}'

/** Same marker filename `performCopy` writes into the destination dir. */
const MARKER_FILENAME = '.comfyui-desktop-2'

interface InstallationLike {
  id: string
  name: string
  installPath?: string
}

interface CopyResult {
  ok: boolean
  message?: string
  navigate?: string
  newInstallationId?: string
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
  sourcePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-copy-plain-e2e-'))
  await mkdir(sourcePath, { recursive: true })
  // Marker file is required for delete-style ops; performCopy doesn't gate
  // on it, but seeding it lets us assert the destination gets a FRESH
  // marker (containing the new id) rather than the source's copy.
  await writeFile(path.join(sourcePath, MARKER_FILENAME), SOURCE_ID)
  await writeFile(path.join(sourcePath, EXTRA_FILENAME), EXTRA_CONTENTS)

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

test('Copy creates a new install on disk + in the registry, source untouched @lifecycle', async () => {
  const result = await ctx.panel.evaluate<CopyResult>(
    `window.api.runAction(${JSON.stringify(SOURCE_ID)}, 'copy', { name: ${JSON.stringify(COPY_NAME)} })`,
  )
  expect(result.ok, `runAction('copy') failed: ${result.message ?? ''}`).toBe(true)
  expect(result.navigate, 'plain copy must navigate to list (chooser)').toBe('list')
  expect(typeof result.newInstallationId).toBe('string')
  expect(result.newInstallationId).not.toBe(SOURCE_ID)
  const newId = result.newInstallationId!

  // Registry: getInstallations() now enumerates the new entry alongside
  // the source. Name is uniqueified by `uniqueName` — first use of the
  // requested name is taken verbatim, so the seeded source dictates
  // there's no collision.
  const installations = await ctx.panel.evaluate<InstallationLike[]>(
    'window.api.getInstallations()',
  )
  const newEntry = installations.find((i) => i.id === newId)
  expect(newEntry, 'new install id not enumerated after copy').toBeDefined()
  expect(newEntry?.name).toBe(COPY_NAME)
  expect(newEntry?.installPath, 'new install must have a destination path').toBeTruthy()
  expect(installations.find((i) => i.id === SOURCE_ID), 'source install dropped after copy').toBeDefined()

  // Disk: destination dir exists, contains the user-data file copied
  // from source, AND the marker file was rewritten with the NEW id (not
  // the source id).
  const destPath = newEntry!.installPath!
  expect(destPath).not.toBe(sourcePath)
  expect(await pathExists(destPath), `destination dir ${destPath} missing after copy`).toBe(true)

  const copiedExtra = await readFile(path.join(destPath, EXTRA_FILENAME), 'utf8')
  expect(copiedExtra, 'extra file did not copy through').toBe(EXTRA_CONTENTS)

  const destMarker = await readFile(path.join(destPath, MARKER_FILENAME), 'utf8')
  expect(destMarker, 'destination marker was not rewritten with the new install id').toBe(newId)

  // Source must remain pristine — same dir, same marker contents, same
  // user-data file. Plain copy is non-destructive on the source side.
  expect(await pathExists(sourcePath), 'source dir disappeared after copy').toBe(true)
  const sourceMarker = await readFile(path.join(sourcePath, MARKER_FILENAME), 'utf8')
  expect(sourceMarker, 'source marker was mutated by copy').toBe(SOURCE_ID)
  const sourceExtra = await readFile(path.join(sourcePath, EXTRA_FILENAME), 'utf8')
  expect(sourceExtra, 'source extra file was mutated by copy').toBe(EXTRA_CONTENTS)

  // Cleanup the per-run destination dir so a re-run of this suite
  // starts from a clean slate (registry entries are wiped by
  // `ctx.cleanup`, but `parentDir` is `os.tmpdir()` so leftover dirs
  // would accumulate across reruns).
  await rm(destPath, { recursive: true, force: true })
})
