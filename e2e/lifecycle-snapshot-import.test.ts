/**
 * Lifecycle E2E: snapshot import end-to-end through the Snapshots tab
 * UI (lifecycle audit gap #10).
 *
 * Drives the production wiring from the Import button click down to a
 * new snapshot file landing on disk and showing in the registry:
 *   - toolbar Import button → `handleImport` →
 *     `window.api.importSnapshotsPreview` → `dialog.showOpenDialog`
 *     (stubbed to return the seeded envelope path) → returns the
 *     parsed envelope,
 *   - SnapshotsView's preview confirm modal → user clicks Continue
 *     (`modalConfirm` testid),
 *   - `importSnapshotsDiff` then `importSnapshotsConfirm` resolve
 *     against the install and the imported snapshot record lands
 *     under `<installPath>/.launcher/snapshots/`.
 *
 * The follow-on `snapshot-restore` runAction emitted by SnapshotsView
 * is out of scope here — it requires real git repos to drive (covered
 * by `lifecycle-snapshot-restore.test.ts`). We assert the import
 * succeeded by polling for the install's snapshot count to advance
 * before the restore op gets a chance to do anything that would
 * interfere with the assertion.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { titlePopupPage } from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let installPath = ''
let envelopeDir = ''
let envelopePath = ''

const INSTALL_ID = 'inst-snapshot-import-test'
const INSTALL_NAME = 'Snapshot Import Test'
const IMPORTED_COMMIT = 'c'.repeat(40)
const IMPORTED_LABEL = 'imported-from-envelope'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-import-e2e-'))
  envelopeDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-import-src-'))
  await mkdir(path.join(installPath, 'ComfyUI'), { recursive: true })

  // Build a valid export envelope on disk; the import handler's
  // `validateExportEnvelope` checks the version/type/trigger/snapshot
  // shape, and the snapshot fields drive the diff against the empty
  // install state (which mismatches on every comfyui field, so the
  // diff is non-empty and import-confirm proceeds).
  envelopePath = path.join(envelopeDir, 'seed-envelope.json')
  const envelope = {
    type: 'comfyui-desktop-2-snapshot',
    version: 1,
    exportedAt: new Date().toISOString(),
    installationName: 'Source Install',
    snapshots: [
      {
        version: 1,
        createdAt: new Date().toISOString(),
        trigger: 'manual',
        label: IMPORTED_LABEL,
        comfyui: {
          ref: IMPORTED_COMMIT,
          commit: IMPORTED_COMMIT,
          releaseTag: 'v0.3.10',
          variant: 'cpu',
          baseTag: 'v0.3.10',
          commitsAhead: 0,
        },
        customNodes: [],
        pipPackages: {},
        updateChannel: 'stable',
      },
    ],
  }
  await writeFile(envelopePath, JSON.stringify(envelope, null, 2))

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

  // Monkey-patch `dialog.showOpenDialog` so the Electron native open
  // dialog never opens during the test; the stub returns the seeded
  // envelope path. The snapshot-restore that fires after a successful
  // import would otherwise need real git repos on disk; the test
  // captures the snapshot count BEFORE the restore op can interfere.
  await ctx.app.evaluate(({ dialog }, filePath) => {
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({
      canceled: false,
      filePaths: [filePath],
    })
  }, envelopePath)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
  if (envelopeDir) await rm(envelopeDir, { recursive: true, force: true })
})

test('Import preview → Continue writes the envelope snapshot into the install @lifecycle', async () => {
  // Sanity: empty install starts with zero snapshots.
  const initialCount = await ctx.panel.evaluate<number>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.length)`,
  )
  expect(initialCount).toBe(0)

  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        initialTab: 'snapshots',
      })
      return true
    })()`,
  )
  const popup = titlePopupPage(ctx.app)
  await popup.waitForVisible(byTestId(TID.snapshotsImport), { timeout: 15_000 })

  expect(await popup.click(byTestId(TID.snapshotsImport))).toBe(true)

  // The preview confirm modal mounts in the popup webContents. Simple
  // confirms route through BaseAlert (test-id `base-alert-action`);
  // rich confirms keep the legacy ModalDialog path (`modal-confirm-button`).
  // Accept either so the test stays stable across the dialog refactors.
  const confirmSelector =
    `${byTestId(TID.modalConfirm)}, ${byTestId(TID.baseAlertAction)}`
  await popup.waitForVisible(confirmSelector, { timeout: 10_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  // Poll for the snapshot to land on disk + the registry refresh.
  // The import path writes the JSON synchronously then calls
  // installations.update(snapshotCount), so a single poll on
  // `getSnapshots` covers both. Generous timeout because the import-
  // confirm chains diffAgainstCurrent which reads the install dir.
  await expect
    .poll(
      async () =>
        ctx.panel.evaluate<number>(
          `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.length)`,
        ),
      { timeout: 15_000, intervals: [250, 500] },
    )
    .toBe(1)

  const snapshots = await ctx.panel.evaluate<Array<{ label: string | null; comfyuiVersion?: string }>>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.map(s => ({ label: s.label, comfyuiVersion: s.comfyuiVersion })))`,
  )
  expect(snapshots.length).toBe(1)
  expect(snapshots[0]?.label).toBe(IMPORTED_LABEL)
})
