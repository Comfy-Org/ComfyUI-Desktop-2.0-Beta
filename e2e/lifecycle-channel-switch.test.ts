/**
 * Lifecycle E2E: ChannelPicker draft-channel actions (Issue #591 audit).
 *
 * The Settings → Updates → ChannelPicker exposes per-channel action
 * buttons when the user drafts a different channel from the dropdown.
 * Two of those buttons carry the drafted channel in `actionData.channel`
 * and route into the standalone source's update path:
 *
 *   - `Update Now`     → `update-comfyui` (in-place update on the target channel)
 *   - `Copy & Update`  → `copy-update`     (new install on the target channel)
 *
 * These tests drive the real UI through the picker and assert:
 *   1. The in-place `Update Now` cross-channel button wires `actionData.channel`
 *      to the run-action IPC even though the no-git stub install can't
 *      complete the update.
 *   2. The `Copy & Update` cross-channel button creates a new install entry
 *      with the target channel as its `updateChannel`, AND does NOT
 *      spawn a new window on success — the channel-switch invocation
 *      comes from inside the source install's host, so the kebab-path
 *      `openInstallWindow` behavior would only stack an empty chooser
 *      on top of the user's existing surface. `handleCopyUpdate`
 *      now omits `newInstallationId` when `actionData.channel` is
 *      present so `ProgressModal.handleDone` skips the open branch.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { closeTitlePopupIfOpen, titlePopupPage, waitForWebContents } from './support/cdpPages'
import { getIpcInvocations, resetIpcInvocations, seedReleaseCache } from './support/devHooks'
import { TID, byTestId } from './support/testIds'

let ctx: AppContext
let installPath = ''

const INSTALL_ID = 'inst-channel-switch'
const INSTALL_NAME = 'Channel Switch Install'
const SOURCE_CHANNEL = 'stable'
const TARGET_CHANNEL = 'latest'
const COMFYUI_REPO = 'Comfy-Org/ComfyUI'
const SEEDED_BASE_TAG = 'v0.1.0'
const SEEDED_COMMIT = 'a'.repeat(40)
const LATEST_STABLE_TAG = 'v9.9.9'
const LATEST_SHA = 'b'.repeat(40)
const COPY_NAME = 'Channel Switch Copy'

interface RunActionInvocation {
  installationId: string
  actionId: string
  actionData?: Record<string, unknown>
}

interface OpenInstallWindowInvocation {
  installationId?: string
}

interface InstallationLike {
  id: string
  name: string
  updateChannel?: string
  installPath?: string
}

async function openPickerOnUpdateTab(installationId: string): Promise<void> {
  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(installationId)},
        mode: 'expanded',
        initialTab: 'update',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
}

/** Drive the ChannelPicker's BaseSelect to draft `targetLabel`. The
 *  BaseSelect renders as a `role="combobox"` button whose teleported
 *  listbox shows one `role="option"` per channel — click the trigger
 *  then the matching option by visible label text. */
async function draftChannel(targetLabel: string): Promise<void> {
  const popup = titlePopupPage(ctx.app)
  await popup.waitForSelector('button[role="combobox"]', { timeout: 15_000 })
  expect(await popup.click('button[role="combobox"]')).toBe(true)
  await popup.waitForVisible('[role="listbox"] [role="option"]', { timeout: 5_000 })
  expect(
    await popup.clickByText('[role="listbox"] [role="option"]', targetLabel),
    `option "${targetLabel}" not found in BaseSelect listbox`,
  ).toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-channel-switch-e2e-'))
  // hasGit gate inside updateSections requires `ComfyUI/.git` to exist
  // for the cross-channel `update-comfyui` / `copy-update` actions to
  // attach to the channel-card options. An empty `.git` dir satisfies
  // the `fs.existsSync` probe; `handleUpdateComfyUI` then fails at the
  // masterPython check (no real venv), which is the no-op outcome we
  // want to pin for test 1.
  await mkdir(path.join(installPath, 'ComfyUI', '.git'), { recursive: true })

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID,
        name: INSTALL_NAME,
        installPath,
        sourceId: 'standalone',
        status: 'installed',
        updateChannel: SOURCE_CHANNEL,
        comfyVersion: { commit: SEEDED_COMMIT, baseTag: SEEDED_BASE_TAG, commitsAhead: 0 },
        releaseTag: SEEDED_BASE_TAG,
        variant: 'cpu',
        pythonVersion: '3.12',
      },
    ],
  })

  // Seed both channels so `updateAvailable` flips true on both cards
  // regardless of which one the user drafts. Real network is bypassed.
  // `releaseNotes` is non-empty so the action's `confirm.messageDetails`
  // populates and the modal lands on the rich-confirm path
  // (TID.modalConfirm) — same branch lifecycle.test.ts drives.
  const now = Date.now()
  await seedReleaseCache(ctx.app, COMFYUI_REPO, 'stable', {
    checkedAt: now,
    latestTag: LATEST_STABLE_TAG,
    releaseName: LATEST_STABLE_TAG,
    releaseNotes: 'Seeded stable release notes.',
  })
  await seedReleaseCache(ctx.app, COMFYUI_REPO, 'latest', {
    checkedAt: now,
    latestTag: LATEST_SHA.slice(0, 7),
    releaseName: LATEST_SHA.slice(0, 7),
    commitSha: LATEST_SHA,
    baseTag: SEEDED_BASE_TAG,
    commitsAhead: 1,
    releaseNotes: 'Seeded latest release notes.',
  })
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
})

test('cross-channel Update Now wires actionData.channel into the run-action IPC @lifecycle', async () => {
  await resetIpcInvocations(ctx.app, 'run-action')

  await openPickerOnUpdateTab(INSTALL_ID)
  // Let the picker's ComfyUISettingsContent finish its initial mount +
  // section load before we draft a channel. Without this the BaseSelect
  // may swap the option list mid-click and lose the `update-comfyui`
  // action button.
  const popup = titlePopupPage(ctx.app)
  await popup.waitForSelector('button[role="combobox"]', { timeout: 15_000 })
  await draftChannel('Latest on GitHub')

  await popup.waitForSelector(byTestId(TID.updateActionButton('update-comfyui')), { timeout: 15_000 })
  expect(await popup.click(byTestId(TID.updateActionButton('update-comfyui')))).toBe(true)

  // confirm.messageDetails is set (we seeded releaseNotes), so the
  // modal lands on the rich-confirm branch — TID.modalConfirm is the
  // primary CTA there.
  await popup.waitForVisible(byTestId(TID.modalConfirm), { timeout: 15_000 })
  expect(await popup.click(byTestId(TID.modalConfirm))).toBe(true)

  // The run-action IPC must carry the drafted channel.
  await expect
    .poll(async () => {
      const calls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
      return calls.find(
        (c) => c.installationId === INSTALL_ID && c.actionId === 'update-comfyui',
      )
    }, { timeout: 30_000, intervals: [200, 500] })
    .toBeTruthy()

  const calls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
  const updateCall = calls.find(
    (c) => c.installationId === INSTALL_ID && c.actionId === 'update-comfyui',
  )
  expect(updateCall, 'update-comfyui IPC not recorded').toBeDefined()
  expect(
    updateCall!.actionData,
    'update-comfyui actionData missing — cross-channel button must pass the target channel',
  ).toBeDefined()
  expect(
    (updateCall!.actionData as { channel?: string }).channel,
    'update-comfyui actionData.channel must be the drafted target',
  ).toBe(TARGET_CHANNEL)

  // Backend bails at the masterPython check (no real venv) — the no-op
  // outcome the user expects from this stub environment. Wait for the
  // ProgressModal to surface the failure before moving on.
  await ctx.panel.waitForVisible(byTestId(TID.progressErrorMessage), { timeout: 30_000 })

  await closeTitlePopupIfOpen(ctx.app)
})

test('cross-channel Copy & Update creates a new install on the target channel without spawning a window @lifecycle', async () => {
  test.setTimeout(120_000)
  await resetIpcInvocations(ctx.app, 'run-action')
  await resetIpcInvocations(ctx.app, 'open-install-window')

  await openPickerOnUpdateTab(INSTALL_ID)
  await draftChannel('Latest on GitHub')

  const popup = titlePopupPage(ctx.app)
  await popup.waitForSelector(byTestId(TID.updateActionButton('copy-update')), { timeout: 15_000 })
  expect(await popup.click(byTestId(TID.updateActionButton('copy-update')))).toBe(true)

  // copy-update carries a `prompt` (field: 'name') — fill the input
  // then confirm. The prompt modal uses the same TID.modalConfirm as
  // the rich-confirm variant.
  await popup.waitForVisible(byTestId(TID.modalPromptInput), { timeout: 15_000 })
  await popup.evaluate<void>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(byTestId(TID.modalPromptInput))})
      if (!el) throw new Error('prompt input missing')
      el.value = ${JSON.stringify(COPY_NAME)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`,
  )
  expect(await popup.click(byTestId(TID.modalConfirm))).toBe(true)

  // The run-action IPC must carry both the typed name AND the drafted
  // channel — that's the cross-channel-copy-update contract.
  await expect
    .poll(async () => {
      const calls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
      return calls.find(
        (c) => c.installationId === INSTALL_ID && c.actionId === 'copy-update',
      )
    }, { timeout: 15_000, intervals: [200, 500] })
    .toBeTruthy()

  const calls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
  const copyCall = calls.find(
    (c) => c.installationId === INSTALL_ID && c.actionId === 'copy-update',
  )
  expect(copyCall, 'copy-update IPC not recorded').toBeDefined()
  const copyData = copyCall!.actionData as { channel?: string; name?: string } | undefined
  expect(copyData?.channel, 'copy-update actionData.channel missing').toBe(TARGET_CHANNEL)
  expect(copyData?.name, 'copy-update actionData.name missing').toBe(COPY_NAME)

  // Wait for the new install to land in the registry on the target
  // channel. The chained update step fails (no real venv) but the
  // copy itself is what populates the entry — `handleCopyUpdate`
  // intentionally keeps the new install when the update leg errors.
  let newId = ''
  await expect
    .poll(async () => {
      const installations = await ctx.panel.evaluate<InstallationLike[]>(
        'window.api.getInstallations()',
      )
      const created = installations.find((i) => i.id !== INSTALL_ID && i.name === COPY_NAME)
      if (created) newId = created.id
      return created?.updateChannel
    }, { timeout: 60_000, intervals: [500, 1_000] })
    .toBe(TARGET_CHANNEL)
  expect(newId, 'new installation id not captured').toBeTruthy()

  // Window-spawn fix: the channel-switch invocation must NOT trigger
  // `openInstallWindow` (which would either focus an existing host
  // for the new install — none exists yet — or open a fresh empty
  // chooser host on top of the source's existing window). Give
  // ProgressModal's 700ms auto-close + handleDone a generous window
  // to fire, then assert the IPC stayed at zero.
  await new Promise((r) => setTimeout(r, 2_000))
  const openCalls = (await getIpcInvocations(
    ctx.app,
    'open-install-window',
  )) as OpenInstallWindowInvocation[]
  expect(
    openCalls.length,
    `channel-switch Copy & Update must not call openInstallWindow; got ${openCalls.length}`,
  ).toBe(0)

  // Cleanup: remove the new install dir so reruns start clean. The
  // registry entry persists in the temp profile dir along with the
  // app's other state and is torn down by `ctx.cleanup`.
  const installations = await ctx.panel.evaluate<InstallationLike[]>(
    'window.api.getInstallations()',
  )
  const newEntry = installations.find((i) => i.id === newId)
  if (newEntry?.installPath) {
    await rm(newEntry.installPath, { recursive: true, force: true })
  }
  await closeTitlePopupIfOpen(ctx.app)
})
