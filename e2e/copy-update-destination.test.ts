/**
 * Copy / copy-update destination focus (issue #582 FLOW 2).
 *
 * `handleCopy` / `handleCopyUpdate` / `handleReleaseUpdate` now return
 * `{ ok: true, navigate: 'list', newInstallationId }` and
 * `ProgressModal.handleDone` reads `newInstallationId` to call
 * `window.api.openInstallWindow(newInstallationId)` — opening the
 * newly-created destination install in its own window without
 * swapping the source host.
 *
 * Test strategy: drive the panel's existing show-progress chain with
 * a synthetic apiCall that resolves to a success payload carrying
 * `newInstallationId`. The actual copy handler is bypassed (it's covered
 * by integration tests + the field is populated unconditionally on
 * the success path of all three handlers); this exercises the
 * renderer-side handleDone branch + the main-side
 * `open-install-window` IPC + the focus-existing-or-open-new
 * behaviour.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import {
  getIpcInvocations,
  resetIpcInvocations,
} from './support/devHooks'

let ctx: AppContext
let sourcePath: string

const SOURCE_ID = 'inst-copy-source-test'
const SOURCE_NAME = 'Source Install'
const DEST_ID = 'inst-copy-destination-test'
const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  sourcePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-copy-dest-e2e-'))
  await mkdir(sourcePath, { recursive: true })
  await writeFile(path.join(sourcePath, MARKER_FILENAME), SOURCE_ID)

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

test.beforeEach(async () => {
  await resetIpcInvocations(ctx.app, 'open-install-window')
})

test('Copy success opens the destination install in a new window @lifecycle', async () => {
  // Drive ProgressModal with a synthetic copy result carrying the
  // destination install id. The renderer's `handleDone` consumes
  // `op.result.newInstallationId` and calls `openInstallWindow`.
  await ctx.panel.evaluate<void>(
    `window.__e2eRenderer.injectProgressSuccess({
      installationId: ${JSON.stringify(SOURCE_ID)},
      title: 'Copy — ' + ${JSON.stringify(SOURCE_NAME)},
      newInstallationId: ${JSON.stringify(DEST_ID)},
    })`,
  )

  // The brand loader auto-closes 700ms after `finished`, then
  // handleDone fires. Poll the recorded IPC invocations.
  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'open-install-window')).length, {
      timeout: 5_000,
      intervals: [100, 250],
    })
    .toBeGreaterThanOrEqual(1)

  const calls = await getIpcInvocations(ctx.app, 'open-install-window') as
    { installationId?: string }[]
  expect(calls.length).toBe(1)
  expect(calls[0]?.installationId).toBe(DEST_ID)
})

test('No newInstallationId → no open-install-window call @lifecycle', async () => {
  // Same shape but no newInstallationId — should NOT trigger
  // openInstallWindow. Guards the conditional branch in handleDone
  // against accidentally firing for non-copy success paths.
  await ctx.panel.evaluate<void>(
    `window.__e2eRenderer.injectProgressSuccess({
      installationId: ${JSON.stringify(SOURCE_ID)},
      title: 'Other op — ' + ${JSON.stringify(SOURCE_NAME)},
    })`,
  )

  // Wait for handleDone's auto-close window to elapse (≥700ms).
  await new Promise((r) => setTimeout(r, 1_500))

  const calls = await getIpcInvocations(ctx.app, 'open-install-window')
  expect(calls.length).toBe(0)
})
