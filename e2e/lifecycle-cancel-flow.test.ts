/**
 * Cancel-flow coverage: ProgressModal Return-to-Dashboard against an
 * in-flight cancellable op, and `useActionGuard.checkBeforeAction`
 * surfacing the "Operation in progress" confirm + driving its cancel
 * branch end-to-end.
 *
 * Both branches share a controllable in-flight op seeded via
 * `__e2eRenderer.startInFlightOp` — the apiCall is a Promise the test
 * resolves with `settleInFlightOp` so the op stays mid-air until the
 * cancel paths fire their teardown IPCs.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { byTestId, TID } from './support/testIds'
import {
  clearRunningSessions,
  getIpcInvocations,
  resetIpcInvocations,
  seedRunningSession,
} from './support/devHooks'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-cancel-flow-test'
const INSTALL_NAME = 'Cancel Me'
const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-cancel-flow-e2e-'))
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
  await clearRunningSessions(ctx.app)
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
})

test.beforeEach(async () => {
  await resetIpcInvocations(ctx.app, 'cancel-operation')
  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await clearRunningSessions(ctx.app)
  // Drop any pending in-flight op left over from a previous test so its
  // settler can't intercept this test's seed.
  await settleInFlightOp({ ok: false, cancelled: true })
})

/** Seed an in-flight op whose apiCall stays pending until the test
 *  resolves it. ProgressModal mounts on the chooser host's takeover
 *  slot exactly the way a real long-running action would render. */
async function startInFlightOp(opts: { destroysInstance?: boolean } = {}): Promise<void> {
  await ctx.panel.evaluate<void>(
    `(async () => {
      await window.__e2eRenderer.startInFlightOp({
        installationId: ${JSON.stringify(INSTALL_ID)},
        title: 'Updating ComfyUI — ' + ${JSON.stringify(INSTALL_NAME)},
        opKind: 'update',
        destroysInstance: ${opts.destroysInstance ? 'true' : 'false'},
      })
    })()`,
  )
  await ctx.panel.waitForVisible('.brand-progress', { timeout: 10_000 })
}

async function settleInFlightOp(result: { ok: boolean; cancelled?: boolean }): Promise<void> {
  await ctx.panel.evaluate<boolean>(
    `window.__e2eRenderer.settleInFlightOp({
      installationId: ${JSON.stringify(INSTALL_ID)},
      result: ${JSON.stringify(result)},
    })`,
  )
}

/** Kick off `runActionGuard` and stash the verdict promise on `window`
 *  so the test can await it later (after driving the confirm modal). */
async function runGuardInBackground(actionLabel: string): Promise<void> {
  await ctx.panel.evaluate<void>(
    `(() => {
      window.__guardPromise = window.__e2eRenderer.runActionGuard({
        installationId: ${JSON.stringify(INSTALL_ID)},
        actionLabel: ${JSON.stringify(actionLabel)},
      })
    })()`,
  )
}

function readGuardVerdict(): Promise<boolean> {
  return ctx.panel.evaluate<boolean>('window.__guardPromise')
}

test('useActionGuard fires cancel-operation when the user confirms cancelling the busy op @lifecycle', async () => {
  // Active session + in-flight op makes the guard's busy check fire.
  await startInFlightOp()
  await runGuardInBackground('Restart ComfyUI')

  // useActionGuard fires a plain confirm (no details / checkboxes), so
  // ModalDialog routes it through `BaseAlert` — its action button uses
  // the `baseAlertAction` test id, not `modalConfirm`.
  await ctx.panel.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 10_000 })
  expect(await ctx.panel.click(byTestId(TID.baseAlertAction))).toBe(true)

  // The guard fires window.api.cancelOperation immediately after the
  // user confirms. main records the invocation before the poll starts.
  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'cancel-operation')).length, {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBeGreaterThanOrEqual(1)
  const cancelCalls = await getIpcInvocations(ctx.app, 'cancel-operation') as string[]
  expect(cancelCalls[0]).toBe(INSTALL_ID)

  // Settle the apiCall so progressStore marks the op finished —
  // getProgressInfo flips to null and the guard's poll exits, returning
  // true so the action would proceed.
  await settleInFlightOp({ ok: false, cancelled: true })
  expect(await readGuardVerdict()).toBe(true)
})

test('useActionGuard returns false without cancelling when the user dismisses the confirm @lifecycle', async () => {
  await startInFlightOp()
  await runGuardInBackground('Restart ComfyUI')

  await ctx.panel.waitForVisible(byTestId(TID.baseAlertCancel), { timeout: 10_000 })
  expect(await ctx.panel.click(byTestId(TID.baseAlertCancel))).toBe(true)
  expect(await readGuardVerdict()).toBe(false)

  // Cancel-operation must NOT fire when the user backs out of the
  // confirm — that would punish them for accidentally hitting an
  // action against a busy install.
  const cancelCalls = await getIpcInvocations(ctx.app, 'cancel-operation')
  expect(cancelCalls.length).toBe(0)

  // Clean up the seeded op so the next test starts fresh.
  await settleInFlightOp({ ok: false, cancelled: true })
})

test('Return-to-Dashboard from in-flight op cancels and closes the takeover @lifecycle', async () => {
  // Seed a real running session so the local-install confirm prompt
  // appears (cloud / remote skip the prompt).
  await seedRunningSession(ctx.app, {
    installationId: INSTALL_ID,
    installationName: INSTALL_NAME,
  })
  // Wait for the renderer to see the install as running — without this
  // the operation would resolve too fast and the user's perception of
  // running state would race the broadcast.
  await expect
    .poll(
      async () => ctx.panel.evaluate<boolean>(
        `window.__e2eRenderer.isRunning(${JSON.stringify(INSTALL_ID)})`,
      ),
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(true)

  await startInFlightOp()
  // The footer renders the Return-to-Dashboard button only when the op
  // is non-destroying (otherwise Cancel takes its place).
  expect(await ctx.panel.clickByText('button', 'Return to Dashboard')).toBe(true)

  // Local-install in-flight: ModalDialog confirm appears as a simple
  // confirm (no details / checkboxes), so it routes through BaseAlert.
  await ctx.panel.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 10_000 })
  expect(await ctx.panel.click(byTestId(TID.baseAlertAction))).toBe(true)

  // progressStore.cancelOperation fires both cancel-operation and
  // stop-comfyui — the latter is what actually drops the running
  // session so the install isn't orphaned.
  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'cancel-operation')).length, {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBeGreaterThanOrEqual(1)
  await expect
    .poll(async () => (await getIpcInvocations(ctx.app, 'stop-comfyui')).length, {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBeGreaterThanOrEqual(1)

  const cancelCalls = await getIpcInvocations(ctx.app, 'cancel-operation') as string[]
  expect(cancelCalls[0]).toBe(INSTALL_ID)

  // Takeover closes — `.brand-progress` is unmounted.
  await expect
    .poll(async () => ctx.panel.exists('.brand-progress'), {
      timeout: 5_000,
      intervals: [100, 200],
    })
    .toBe(false)

  // Resolve the apiCall so the op cleans up. cancelOperation does not
  // mark op.finished — the promise has to settle for the store to
  // clear the op.
  await settleInFlightOp({ ok: false, cancelled: true })
})
