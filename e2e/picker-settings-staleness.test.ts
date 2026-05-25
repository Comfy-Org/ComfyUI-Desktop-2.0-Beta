/**
 * Instance-picker right-pane staleness regression (issue #582 fix #1).
 *
 * The picker's expanded mode mounts `ComfyUISettingsContent` against
 * the selected install. Before the fix, clicking a different row left
 * the previous install's sections painted while the new install's
 * `get-detail-sections` IPC was still in flight — and a slow
 * out-of-order resolution could re-stamp install A's sections on top
 * of B's right pane.
 *
 * The fix in `useComfyUISettings`:
 *
 *   1. Clears `sections` immediately when `installationId` changes so
 *      the loading placeholder takes over the right pane during the
 *      gap.
 *   2. Stamps every in-flight `get-detail-sections` request with a
 *      monotonic sequence number and drops any response whose
 *      sequence has since been superseded.
 *
 * This test seeds two installs, opens the picker in expanded mode for
 * A, then switches to B and asserts that the sections pane's
 * `data-install-id` never stays on "A" once the switch is initiated
 * — it must either render the loading placeholder or flip to B's
 * sections.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { titlePopupPage, waitForWebContents } from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let installAPath: string
let installBPath: string

const INSTALL_A_ID = 'inst-picker-a'
const INSTALL_A_NAME = 'Install A'
const INSTALL_B_ID = 'inst-picker-b'
const INSTALL_B_NAME = 'Install B'

const MARKER_FILENAME = '.comfyui-desktop-2'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installAPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-picker-a-e2e-'))
  installBPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-picker-b-e2e-'))
  await mkdir(installAPath, { recursive: true })
  await mkdir(installBPath, { recursive: true })
  await writeFile(path.join(installAPath, MARKER_FILENAME), INSTALL_A_ID)
  await writeFile(path.join(installBPath, MARKER_FILENAME), INSTALL_B_ID)

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_A_ID,
        name: INSTALL_A_NAME,
        installPath: installAPath,
        sourceId: 'standalone',
        status: 'installed',
      },
      {
        id: INSTALL_B_ID,
        name: INSTALL_B_NAME,
        installPath: installBPath,
        sourceId: 'standalone',
        status: 'installed',
      },
    ],
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installAPath) await rm(installAPath, { recursive: true, force: true })
  if (installBPath) await rm(installBPath, { recursive: true, force: true })
})

test('right pane clears stale sections when switching install A → B @lifecycle', async () => {
  // Open the picker directly in expanded mode, pre-selected on A.
  // `openInstancePicker` is the same renderer-facing bridge the title
  // bar uses; we drive it from the panel so we don't have to chase
  // the title-bar button geometry.
  const opened = await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_A_ID)},
        mode: 'expanded',
        initialTab: 'config',
      })
      return true
    })()`,
  )
  expect(opened).toBe(true)

  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  // Wait for A's sections to render in the right pane.
  await popup.waitForVisible(byTestId(TID.pickerSettingsSections), { timeout: 15_000 })
  await popup.waitFor(
    async () => (await popup.evaluate<string | null>(
      `(() => { const el = document.querySelector('${byTestId(TID.pickerSettingsSections)}'); return el ? el.getAttribute('data-install-id') : null })()`,
    )) === INSTALL_A_ID,
    { timeout: 10_000, message: 'right pane never settled on Install A' },
  )

  // Click Install B's left-pane row.
  const clickedB = await popup.click(byTestId(TID.pickerRow(INSTALL_B_ID)))
  expect(clickedB, 'Install B row click dispatched').toBe(true)

  // Staleness assertion: after switching, the sections pane must NOT
  // still carry A's id. Either the loading placeholder takes over
  // (sections gone), or the pane flips to B. The bug we're guarding
  // against would leave A's data-install-id painted while B's IPC
  // resolves.
  await popup.waitFor(
    async () => {
      const state = await popup.evaluate<{ sectionsId: string | null; loadingVisible: boolean }>(
        `(() => {
          const sec = document.querySelector('${byTestId(TID.pickerSettingsSections)}')
          const sectionsId = sec ? sec.getAttribute('data-install-id') : null
          const loading = document.querySelector('${byTestId(TID.pickerSettingsLoading)}')
          return { sectionsId, loadingVisible: !!loading }
        })()`,
      )
      return state.loadingVisible || state.sectionsId === INSTALL_B_ID
    },
    {
      timeout: 5_000,
      message: 'right pane stayed on Install A after switching to B (stale-data regression)',
    },
  )

  // And the pane should eventually settle on B (proves the new IPC
  // response was applied, not the stale one).
  await popup.waitFor(
    async () => (await popup.evaluate<string | null>(
      `(() => { const el = document.querySelector('${byTestId(TID.pickerSettingsSections)}'); return el ? el.getAttribute('data-install-id') : null })()`,
    )) === INSTALL_B_ID,
    { timeout: 15_000, message: 'right pane never settled on Install B after switch' },
  )
})
