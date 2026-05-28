/**
 * Lifecycle E2E: ProgressModal port-conflict footer (lifecycle audit
 * gap #7).
 *
 * Drives the post-failure UI that fires when `runAction('launch')`
 * returns `{ ok: false, portConflict: {...} }`. The real port-conflict
 * detection in `src/main/lib/ipc/sessionActions/launch.ts` is covered
 * by unit tests; what's NOT pinned today is the user-facing recovery
 * path:
 *   - the port-conflict banner replaces the generic "Operation failed"
 *     banner when `result.portConflict` is set,
 *   - "Use port N instead" → fires `runAction('launch', { portOverride })`,
 *   - "Stop process and retry" → confirms in a BaseAlert, hits
 *     `killPortProcess`, then re-invokes `op.apiCall` (NOT the
 *     fresh-launch fallback).
 *
 * We inject the port-conflict result via `injectPortConflictResult`
 * rather than binding a real socket because:
 *   1. handleUseNextPort fires a fresh `runAction('launch')` whose
 *      subsequent failure (no real Python install) would race the IPC
 *      assertion and inject confusing noise,
 *   2. handleKillProcess invokes the platform's `killByPort` against
 *      whatever PID owns the port — the test must not unleash
 *      taskkill / SIGKILL against an arbitrary process the harness
 *      doesn't own.
 *
 * The IPC assertions (run-action with portOverride; kill-port-process
 * with the conflict port; op.apiCall re-invocation counter) prove the
 * UI buttons drive the production paths end-to-end.
 *
 * FOLLOWUP: add a sibling lifecycle test that drives a REAL port
 * conflict against the live `lifecycle.test.ts` standalone install
 * (which already pays the ~500MB download cost). A real test would:
 *   1. bind the install's launch port via `net.createServer` so the
 *      handler in `launch.ts` actually observes `isPortListening` true,
 *   2. drive `runAction('launch')` from the picker / dashboard and
 *      assert the port-conflict footer mounts from a real backend
 *      result (not an injected one),
 *   3. for "Use Next Port" — pre-stub `findAvailablePort` (or scope
 *      the net.createServer to a fixed busy port + assert the second
 *      launch attempt succeeds on `nextPort`),
 *   4. for "Kill Process" — scope `killByPort` to only kill PIDs the
 *      test owns (the bound server) so taskkill / SIGKILL cannot
 *      escape onto the Playwright runner itself.
 * The synthetic test here pins the UI contract; a real-conflict test
 * pins that the main-side detection path still wires through to the
 * same ProgressModal surface.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { byTestId, TID } from './support/testIds'
import { getIpcInvocations, resetIpcInvocations } from './support/devHooks'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-port-conflict-test'
const INSTALL_NAME = 'Port Conflict Install'
const MARKER_FILENAME = '.comfyui-desktop-2'
const OCCUPIED_PORT = 65432
const NEXT_PORT = 65433

interface RunActionInvocation {
  installationId: string
  actionId: string
  actionData?: Record<string, unknown>
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-port-conflict-e2e-'))
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

test.beforeEach(async () => {
  await resetIpcInvocations(ctx.app, 'run-action')
  await resetIpcInvocations(ctx.app, 'kill-port-process')
})

async function injectConflict(): Promise<void> {
  await ctx.panel.evaluate<void>(`(async () => {
    await window.__e2eRenderer.injectPortConflictResult({
      installationId: ${JSON.stringify(INSTALL_ID)},
      title: 'Launching ComfyUI',
      port: ${OCCUPIED_PORT},
      nextPort: ${NEXT_PORT},
      isComfy: true,
    })
  })()`)
}

test('port-conflict banner + dual-action footer render when result.portConflict is set @ci', async () => {
  await injectConflict()

  await ctx.panel.waitForVisible(byTestId(TID.progressPortConflictBanner), { timeout: 10_000 })
  await ctx.panel.waitForVisible(byTestId(TID.progressPortConflictUsePort), { timeout: 5_000 })
  await ctx.panel.waitForVisible(byTestId(TID.progressPortConflictKill), { timeout: 5_000 })

  // The generic error footer (Reboot) must NOT appear alongside the
  // port-conflict footer — they live in mutually exclusive branches of
  // ProgressModal's footer template.
  expect(await ctx.panel.exists(byTestId(TID.progressReboot))).toBe(false)
})

test('Use Next Port fires runAction(launch) with portOverride @ci', async () => {
  await injectConflict()
  await ctx.panel.waitForVisible(byTestId(TID.progressPortConflictUsePort), { timeout: 10_000 })

  expect(await ctx.panel.click(byTestId(TID.progressPortConflictUsePort))).toBe(true)

  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, 'run-action')).length,
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBeGreaterThanOrEqual(1)

  const runCalls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
  const launchCall = runCalls.find(
    (c) => c.installationId === INSTALL_ID && c.actionId === 'launch',
  )
  expect(launchCall, 'Use Next Port must fire runAction("launch") for the install').toBeDefined()
  expect(launchCall!.actionData).toEqual({ portOverride: NEXT_PORT })
})

test('Kill Process confirms, hits killPortProcess, then re-invokes op.apiCall @ci', async () => {
  await injectConflict()
  await ctx.panel.waitForVisible(byTestId(TID.progressPortConflictKill), { timeout: 10_000 })

  const beforeCount = await ctx.panel.evaluate<number>(
    `window.__e2eRenderer.getInjectedApiCallCount(${JSON.stringify(INSTALL_ID)})`,
  )
  expect(beforeCount, 'apiCall must have run once for the initial conflict').toBe(1)

  expect(await ctx.panel.click(byTestId(TID.progressPortConflictKill))).toBe(true)

  // BaseAlert confirm appears in the panel (modal.confirm({...}) inside
  // handleKillProcess). Click confirm to proceed.
  await ctx.panel.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 5_000 })
  expect(await ctx.panel.click(byTestId(TID.baseAlertAction))).toBe(true)

  // killPortProcess IPC fires with the conflict port.
  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, 'kill-port-process')).length,
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(1)
  const killCalls = await getIpcInvocations(ctx.app, 'kill-port-process')
  expect(killCalls).toEqual([OCCUPIED_PORT])

  // After kill resolves ok, handleKillProcess calls startOperation
  // with `op.apiCall || (() => runAction('launch'))`. Our injected
  // apiCall is present, so it must be re-invoked (counter advances
  // 1 → 2). The fresh-launch fallback would leave the counter at 1
  // AND fire a run-action IPC — neither happens here.
  await expect
    .poll(
      () =>
        ctx.panel.evaluate<number>(
          `window.__e2eRenderer.getInjectedApiCallCount(${JSON.stringify(INSTALL_ID)})`,
        ),
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBeGreaterThanOrEqual(2)

  const runCalls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
  expect(
    runCalls.filter((c) => c.installationId === INSTALL_ID && c.actionId === 'launch'),
    'Kill Process must re-invoke op.apiCall, not the fresh-launch fallback',
  ).toEqual([])
})
