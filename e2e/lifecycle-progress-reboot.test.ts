/**
 * Lifecycle E2E: ProgressModal "Reboot" of an errored install (lifecycle
 * audit gap #24).
 *
 * Distinct from the failure-then-retry path (#7) — here the install is
 * already in `sessionStore.errorInstances` BEFORE the user interacts with
 * the ProgressModal. We seed an errorInstance directly, then drive a
 * retryable apiCall through `injectRetryableProgressError` so the op
 * lands in ProgressModal's error footer; clicking Reboot must re-invoke
 * the SAME `op.apiCall` (proven by the call-counter helper) and the op
 * must transition back through running → finished/ok in place.
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

const INSTALL_ID = 'inst-reboot-errored-test'
const INSTALL_NAME = 'Errored Reboot Install'
const MARKER_FILENAME = '.comfyui-desktop-2'
const PRE_EXISTING_ERROR = 'Earlier crash: ComfyUI exited with code 1'
const OP_FAILURE_MESSAGE = 'Initial op failure: simulated launch failure'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-reboot-errored-e2e-'))
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

test('ProgressModal Reboot re-runs the same apiCall to recover an errored install @lifecycle', async () => {
  // Seed a pre-existing errorInstance to mimic the audit's #24 setup —
  // the install was already errored before the user took any action
  // against it (distinct from #7, where the error originates inside the
  // op the user just launched).
  await ctx.panel.evaluate<void>(`(() => {
    window.__e2eRenderer.seedErrorInstance({
      installationId: ${JSON.stringify(INSTALL_ID)},
      installationName: ${JSON.stringify(INSTALL_NAME)},
      message: ${JSON.stringify(PRE_EXISTING_ERROR)},
    })
  })()`)
  const seeded = await ctx.panel.evaluate<boolean>(
    `window.__e2eRenderer.hasErrorInstance(${JSON.stringify(INSTALL_ID)})`,
  )
  expect(seeded, 'seedErrorInstance must register the install in errorInstances').toBe(true)

  // Inject a retryable failing op: first apiCall returns
  // `{ ok: false, message }`, the next one (driven by Reboot) returns
  // `{ ok: true }`. progressStore writes the failure into
  // `currentOp.error` AND replaces the errorInstance entry with the
  // op-failure message — exercising the same store path the production
  // failure flow takes.
  await ctx.panel.evaluate<void>(`(async () => {
    await window.__e2eRenderer.injectRetryableProgressError({
      installationId: ${JSON.stringify(INSTALL_ID)},
      title: 'Launching ComfyUI',
      errorMessage: ${JSON.stringify(OP_FAILURE_MESSAGE)},
      failuresBeforeSuccess: 1,
    })
  })()`)

  // Error footer appears.
  await ctx.panel.waitForVisible(byTestId(TID.progressErrorMessage), { timeout: 10_000 })
  await ctx.panel.waitForVisible(byTestId(TID.progressReboot), { timeout: 10_000 })

  // The apiCall has been invoked exactly once at this point.
  const beforeReboot = await ctx.panel.evaluate<number>(
    `window.__e2eRenderer.getInjectedApiCallCount(${JSON.stringify(INSTALL_ID)})`,
  )
  expect(beforeReboot, 'apiCall must have run once for the seeded failure').toBe(1)

  // Click Reboot. handleReboot calls `progressStore.startOperation`
  // with `op.apiCall || (() => runAction(id, 'launch'))` — proving the
  // re-run requires the counter to advance to 2 (NOT a fresh
  // runAction('launch') fallback, which would leave the counter at 1).
  expect(await ctx.panel.click(byTestId(TID.progressReboot))).toBe(true)

  // Counter advances: same closure was re-invoked.
  await expect
    .poll(
      () =>
        ctx.panel.evaluate<number>(
          `window.__e2eRenderer.getInjectedApiCallCount(${JSON.stringify(INSTALL_ID)})`,
        ),
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBeGreaterThanOrEqual(2)

  // Op transitions back to in-flight (error footer disappears), then
  // resolves with `{ ok: true }` and the auto-close watcher tears the
  // takeover down — `.brand-progress` leaves the DOM.
  await expect
    .poll(() => ctx.panel.exists(byTestId(TID.progressErrorMessage)), {
      timeout: 10_000,
      intervals: [100, 200],
    })
    .toBe(false)
  await expect
    .poll(() => ctx.panel.exists('.brand-progress'), {
      timeout: 10_000,
      intervals: [200, 500],
    })
    .toBe(false)
})
