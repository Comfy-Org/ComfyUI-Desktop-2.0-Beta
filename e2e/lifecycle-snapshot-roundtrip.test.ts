/**
 * Lifecycle E2E: snapshot export → import round-trip end-to-end
 * (lifecycle audit followup).
 *
 * The standalone export and import tests cover each direction
 * independently, but neither proves the envelope shape produced by
 * `buildExportEnvelope` is the SAME shape consumed by
 * `validateExportEnvelope` + `importSnapshots`. The import test uses
 * a hand-built envelope JSON, so a future schema drift on the export
 * side would not be caught.
 *
 * This test closes that loop:
 *   - INSTALL_A is seeded with two snapshots and exports them via
 *     the toolbar Export All button (stubbed `dialog.showSaveDialog`
 *     writes to a known tmp dir),
 *   - INSTALL_B starts with zero snapshots and imports the resulting
 *     envelope via the toolbar Import button (stubbed
 *     `dialog.showOpenDialog` returns the path saved by the save
 *     stub, shared via a globalThis property),
 *   - both seeded labels end up on B's snapshot list, proving the
 *     full envelope (not just the newest entry) round-trips through
 *     the real production code paths.
 *
 * The follow-on `snapshot-restore` runAction that fires after
 * import-confirm is out of scope (covered by
 * lifecycle-snapshot-restore.test.ts); the count + label assertions
 * race against the restore op intentionally — both poll/read on
 * `getSnapshots`, which returns the registry's view of disk before
 * restore touches anything that would interfere.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { titlePopupPage } from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let installPathA = ''
let installPathB = ''
let exportDir = ''

const INSTALL_ID_A = 'inst-snapshot-roundtrip-a'
const INSTALL_NAME_A = 'Snapshot Roundtrip Source'
const INSTALL_ID_B = 'inst-snapshot-roundtrip-b'
const INSTALL_NAME_B = 'Snapshot Roundtrip Target'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const BASE_TAG = 'v0.3.10'
const LABEL_FIRST = 'first-seeded'
const LABEL_SECOND = 'second-seeded'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPathA = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-rt-a-'))
  installPathB = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-rt-b-'))
  exportDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-rt-out-'))
  await mkdir(path.join(installPathA, 'ComfyUI'), { recursive: true })
  await mkdir(path.join(installPathB, 'ComfyUI'), { recursive: true })

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID_A,
        name: INSTALL_NAME_A,
        installPath: installPathA,
        sourceId: 'standalone',
        status: 'installed',
        snapshots: [
          {
            trigger: 'manual',
            label: LABEL_FIRST,
            comfyui: {
              ref: COMMIT_A,
              commit: COMMIT_A,
              releaseTag: BASE_TAG,
              variant: 'cpu',
              baseTag: BASE_TAG,
              commitsAhead: 1,
            },
          },
          {
            trigger: 'manual',
            label: LABEL_SECOND,
            comfyui: {
              ref: COMMIT_B,
              commit: COMMIT_B,
              releaseTag: BASE_TAG,
              variant: 'cpu',
              baseTag: BASE_TAG,
              commitsAhead: 2,
            },
          },
        ],
      },
      {
        id: INSTALL_ID_B,
        name: INSTALL_NAME_B,
        installPath: installPathB,
        sourceId: 'standalone',
        status: 'installed',
      },
    ],
  })

  // Stub both save + open dialogs at boot. The save stub returns a
  // deterministic path inside `exportDir` keyed off the requested
  // `defaultPath` filename and parks the resulting absolute path on
  // `globalThis` so the open stub can read it back without the test
  // having to plumb the value through across two evaluate calls.
  await ctx.app.evaluate(({ dialog }, dir) => {
    const g = globalThis as unknown as { __roundtripExportedPath?: string }
    ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (
      _win: unknown,
      opts: { defaultPath?: string },
    ) => {
      const raw = opts.defaultPath ?? 'snapshot-export.json'
      const lastSep = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
      const base = lastSep >= 0 ? raw.slice(lastSep + 1) : raw
      const sep = dir.includes('\\') ? '\\' : '/'
      const filePath = `${dir}${sep}${base}`
      g.__roundtripExportedPath = filePath
      return { canceled: false, filePath }
    }
    ;(dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
      const filePath = g.__roundtripExportedPath
      if (!filePath) return { canceled: true, filePaths: [] }
      return { canceled: false, filePaths: [filePath] }
    }
  }, exportDir)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installPathA) await rm(installPathA, { recursive: true, force: true })
  if (installPathB) await rm(installPathB, { recursive: true, force: true })
  if (exportDir) await rm(exportDir, { recursive: true, force: true })
})

async function openSnapshotsTab(installId: string): Promise<ReturnType<typeof titlePopupPage>> {
  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(installId)},
        initialTab: 'snapshots',
      })
      return true
    })()`,
  )
  const popup = titlePopupPage(ctx.app)
  await popup.waitForVisible(byTestId(TID.snapshotsImport), { timeout: 15_000 })
  return popup
}

async function findExportedFile(prefix: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(exportDir)
  const match = entries.find((e) => e.startsWith(prefix) && e.endsWith('.json'))
  return match ? path.join(exportDir, match) : null
}

test('Export All from A writes an envelope containing both seeded snapshots @ci', async () => {
  const popup = await openSnapshotsTab(INSTALL_ID_A)

  await popup.waitForVisible(byTestId(TID.snapshotsExportAll), { timeout: 5_000 })
  expect(await popup.click(byTestId(TID.snapshotsExportAll))).toBe(true)

  const exportedPath = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const poll = async (): Promise<void> => {
      const match = await findExportedFile('snapshots-')
      if (match) return resolve(match)
      if (Date.now() > deadline) return reject(new Error('export-all file did not appear within 10s'))
      setTimeout(poll, 200)
    }
    void poll()
  })

  const { readFile } = await import('node:fs/promises')
  const content = await readFile(exportedPath, 'utf-8')
  const envelope = JSON.parse(content) as {
    type?: string
    installationName?: string
    snapshots?: Array<{ label?: string }>
  }
  expect(envelope.type).toBe('comfyui-desktop-2-snapshot')
  expect(envelope.installationName).toBe(INSTALL_NAME_A)
  expect(envelope.snapshots?.length).toBe(2)
  const labels = envelope.snapshots?.map((s) => s.label) ?? []
  expect(labels).toContain(LABEL_FIRST)
  expect(labels).toContain(LABEL_SECOND)
})

test('Import into B consumes the envelope and writes both snapshots @ci', async () => {
  const initialCount = await ctx.panel.evaluate<number>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID_B)}).then(d => d.snapshots.length)`,
  )
  expect(initialCount).toBe(0)

  const popup = await openSnapshotsTab(INSTALL_ID_B)

  expect(await popup.click(byTestId(TID.snapshotsImport))).toBe(true)

  // Simple confirms route through BaseAlert (`base-alert-action`);
  // rich confirms keep the legacy ModalDialog path (`modal-confirm-button`).
  const confirmSelector =
    `${byTestId(TID.modalConfirm)}, ${byTestId(TID.baseAlertAction)}`
  await popup.waitForVisible(confirmSelector, { timeout: 10_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  // importSnapshots writes one file per envelope entry, so the count
  // must advance from 0 to 2. The follow-on snapshot-restore op fires
  // after import-confirm; it operates on git repos we never seeded,
  // so it fails silently in the background — the count assertion
  // races it but lands first because the registry refresh follows
  // the file writes synchronously.
  await expect
    .poll(
      async () =>
        ctx.panel.evaluate<number>(
          `window.api.getSnapshots(${JSON.stringify(INSTALL_ID_B)}).then(d => d.snapshots.length)`,
        ),
      { timeout: 15_000, intervals: [250, 500] },
    )
    .toBe(2)

  const labels = await ctx.panel.evaluate<Array<string | null>>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID_B)}).then(d => d.snapshots.map(s => s.label))`,
  )
  expect(labels).toContain(LABEL_FIRST)
  expect(labels).toContain(LABEL_SECOND)
})
