/**
 * Lifecycle E2E: `comfy://` deep links.
 *
 * Main forwards `comfy://` URL clicks into the host's panel webContents
 * as `panel-trigger-overlay` IPCs (see `index.ts` / `titlePopup.ts`).
 * The renderer-side dispatcher is `useDeepLinkRouter`, which fans out
 * to either the instance-picker popup or the global-settings popup
 * depending on the payload kind.
 *
 * This test replays the IPC directly into the chooser host's panel
 * webContents and asserts the corresponding main-side popup IPC fires.
 * The install-backed expansion of these deep links is covered at the
 * unit level by `PanelApp.test.ts` (mountPanel runs with
 * `installationId=test-id` in the URL), which is the same callback
 * the IPC dispatches into here.
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { getIpcInvocations, resetIpcInvocations } from './support/devHooks'

let ctx: AppContext
let installPath: string

const INSTALL_ID = 'inst-deep-link-test'
const INSTALL_NAME = 'Deep Link Target'
const MARKER_FILENAME = '.comfyui-desktop-2'

interface OpenInstancePickerCall {
  installationId: string | null
  mode: 'compact' | 'expanded'
  initialTab: string | null
  autoAction: string | null
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-deep-links-e2e-'))
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

const PICKER_CHANNEL = 'comfy-window:open-instance-picker-for-install'
const GLOBAL_SETTINGS_CHANNEL = 'comfy-titlepopup:open-global-settings'

test.beforeEach(async () => {
  await resetIpcInvocations(ctx.app, PICKER_CHANNEL)
  await resetIpcInvocations(ctx.app, GLOBAL_SETTINGS_CHANNEL)
})

/** Replay a `panel-trigger-overlay` payload into the chooser host's
 *  panel webContents — the same IPC main fires when a `comfy://` URL
 *  is dispatched. */
async function fireDeepLink(payload: Record<string, unknown>): Promise<void> {
  await ctx.app.evaluate(({ webContents }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
    if (!wc) throw new Error('panel webContents not found')
    wc.send('panel-trigger-overlay', p)
  }, payload)
}

test('comfy://open-settings?tab=global opens Global Settings @lifecycle', async () => {
  await fireDeepLink({ kind: 'open-settings', settingsTab: 'global' })

  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, GLOBAL_SETTINGS_CHANNEL)).length,
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(1)

  // The picker popup must NOT have opened — `tab=global` is a
  // dedicated branch in `useDeepLinkRouter` that never falls through
  // to `openInstancePicker`.
  const pickerCalls = await getIpcInvocations(ctx.app, PICKER_CHANNEL)
  expect(pickerCalls.length).toBe(0)
})

test('comfy://open-settings?tab=comfy on chooser host opens the picker (compact fallback) @lifecycle', async () => {
  // Chooser host has no install backing it, so `useDeepLinkRouter`
  // falls through to the compact picker so the user can pick an
  // install before landing on its Config tab. Install-backed hosts
  // get expanded mode + Config tab — that variant is covered by
  // `PanelApp.test.ts` (mounted with `installationId=test-id`).
  await fireDeepLink({ kind: 'open-settings', settingsTab: 'comfy' })

  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, PICKER_CHANNEL)).length,
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(1)

  const calls = await getIpcInvocations(ctx.app, PICKER_CHANNEL) as OpenInstancePickerCall[]
  // Chooser fallback fires `openInstancePicker()` with no args; the
  // preload bridge normalises that into a payload with `installationId`
  // null and `mode: 'compact'` so the picker opens unanchored to any install.
  expect(calls[0]).toMatchObject({
    installationId: null,
    mode: 'compact',
    initialTab: null,
  })

  const globalCalls = await getIpcInvocations(ctx.app, GLOBAL_SETTINGS_CHANNEL)
  expect(globalCalls.length).toBe(0)
})

test('comfy://install-update with a non-matching installationId is ignored on chooser host @lifecycle', async () => {
  // The chooser host's `opts.installationId` is the empty string. The
  // `install-update` branch guards on `!id || id !== opts.installationId`
  // so a payload for an unrelated install must NOT open any popup
  // — protects the dispatch from firing on the wrong window. The
  // matching-id case is covered at the unit level by `PanelApp.test.ts`.
  await fireDeepLink({ kind: 'install-update', installationId: INSTALL_ID })

  // Round-trip a follow-up `open-settings tab=global` payload so the
  // panel renderer drains the install-update payload before we assert.
  // If install-update had (wrongly) fired the picker IPC, the picker
  // count would already be >= 1 by the time the global-settings handler
  // ran on main.
  await fireDeepLink({ kind: 'open-settings', settingsTab: 'global' })
  await expect
    .poll(
      async () => (await getIpcInvocations(ctx.app, GLOBAL_SETTINGS_CHANNEL)).length,
      { timeout: 5_000, intervals: [100, 200] },
    )
    .toBe(1)

  const pickerCalls = await getIpcInvocations(ctx.app, PICKER_CHANNEL)
  expect(pickerCalls.length).toBe(0)
})
