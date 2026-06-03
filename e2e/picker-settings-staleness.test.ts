/**
 * Instance-picker right-pane staleness regression (issues #582, #782).
 *
 * The picker's expanded mode mounts `ComfyUISettingsContent` against
 * the selected install. Two behaviours must hold when the user
 * clicks a different row in the left list:
 *
 *   - The wrapper's `data-install-id` must reflect the selected
 *     install immediately (bound to the prop). It must never stay on
 *     the previous install once the switch is initiated.
 *
 *   - The right pane must not flash the "Loading…" placeholder. The
 *     #782 fix keeps the previous install's sections painted while
 *     the new install's `get-detail-sections` IPC is in flight; the
 *     placeholder is reserved for true first-load (no prior payload).
 *
 *   - A slow out-of-order response from the previous install (#582)
 *     must not re-stamp its sections on top of the current install's
 *     pane. The composable's monotonic `requestSeq` guards this.
 *
 * The assertion below tolerates either intermediate state — the new
 * install's id OR the loading placeholder — so it stays valid under
 * both the pre-#782 (clear-then-load) and post-#782 (keep-and-swap)
 * behaviours.
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
