/**
 * Lifecycle E2E: snapshot export (single + all) end-to-end through the
 * Snapshots tab UI (lifecycle audit gap #9).
 *
 * Drives the production wiring from the user click down to the JSON
 * envelope landing on disk:
 *   - per-row Export button → `window.api.exportSnapshot` →
 *     `export-snapshot` IPC → `dialog.showSaveDialog` →
 *     `writeFile(envelope)`,
 *   - toolbar Export All button → `window.api.exportAllSnapshots` →
 *     `export-all-snapshots` IPC → same dialog → same writeFile.
 *
 * `dialog.showSaveDialog` is monkey-patched via `app.evaluate` so the
 * Electron native save dialog never opens during the test run; the
 * stub returns deterministic file paths inside the test's tmp dir and
 * the assertions then read the resulting JSON to verify the envelope.
 *
 * The two snapshot records are seeded directly via `installations[].snapshots`
 * so the test does not depend on any real ComfyUI install on disk.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { titlePopupPage } from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let installPath = ''
let exportDir = ''

const INSTALL_ID = 'inst-snapshot-export-test'
const INSTALL_NAME = 'Snapshot Export Test'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const BASE_TAG = 'v0.3.10'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-export-e2e-'))
  exportDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-export-out-'))
  await mkdir(path.join(installPath, 'ComfyUI'), { recursive: true })

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID,
        name: INSTALL_NAME,
        installPath,
        sourceId: 'standalone',
        status: 'installed',
        snapshots: [
          {
            trigger: 'manual',
            label: 'first-seeded',
            createdAt: '2026-01-01T00:00:00.000Z',
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
            label: 'second-seeded',
            createdAt: '2026-01-02T00:00:00.000Z',
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
    ],
  })

  // Monkey-patch `dialog.showSaveDialog` in main BEFORE the user
  // clicks Export so the Electron save dialog never opens during the
  // test run. The stub returns a fresh path inside `exportDir` keyed
  // off the requested `defaultPath` filename — production code uses
  // distinct default names per export variant (single vs all), so the
  // returned path is uniquely identifiable per call.
  await ctx.app.evaluate(({ dialog }, dir) => {
    ;(dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async (
      _win: unknown,
      opts: { defaultPath?: string },
    ) => {
      const raw = opts.defaultPath ?? 'snapshot-export.json'
      const lastSep = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
      const base = lastSep >= 0 ? raw.slice(lastSep + 1) : raw
      const sep = dir.includes('\\') ? '\\' : '/'
      return { canceled: false, filePath: `${dir}${sep}${base}` }
    }
  }, exportDir)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
  if (exportDir) await rm(exportDir, { recursive: true, force: true })
})

async function openSnapshotsTab(): Promise<ReturnType<typeof titlePopupPage>> {
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
  await popup.waitForVisible('.snapshot-row', { timeout: 15_000 })
  return popup
}

async function findExportedFile(prefix: string): Promise<string | null> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(exportDir)
  const match = entries.find((e) => e.startsWith(prefix) && e.endsWith('.json'))
  return match ? path.join(exportDir, match) : null
}

test('per-row Export writes a valid envelope JSON to disk @lifecycle', async () => {
  const popup = await openSnapshotsTab()

  // Read the seeded snapshot filenames off the registry so the test
  // does not have to guess the on-disk filename the harness picked.
  const filenames = await ctx.panel.evaluate<string[]>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.map(s => s.filename))`,
  )
  expect(filenames.length).toBe(2)
  const firstFilename = filenames[0]!

  // SnapshotsView auto-expands the first (newest) row on load, so the
  // Export button is already in the active part of the accordion — no
  // click on the header needed. Just wait for the per-row Export action
  // to render before driving it.
  await popup.waitForSelector('.snapshot-row.is-expanded', { timeout: 5_000 })
  await popup.waitForSelector(byTestId(TID.snapshotRowExport(firstFilename)), { timeout: 5_000 })

  expect(await popup.click(byTestId(TID.snapshotRowExport(firstFilename)))).toBe(true)

  // Wait for the file to land. The handler's `defaultPath` starts
  // with `snapshot-` and is unique per install/trigger/date.
  const exportedPath = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const poll = async (): Promise<void> => {
      const match = await findExportedFile('snapshot-')
      if (match) return resolve(match)
      if (Date.now() > deadline) return reject(new Error('exported file did not appear within 10s'))
      setTimeout(poll, 200)
    }
    void poll()
  })

  expect(existsSync(exportedPath)).toBe(true)
  const content = await readFile(exportedPath, 'utf-8')
  const envelope = JSON.parse(content) as {
    type?: string
    installationName?: string
    snapshots?: Array<{ label?: string; trigger?: string; comfyui?: { commit?: string } }>
  }
  expect(envelope.type).toBe('comfyui-desktop-2-snapshot')
  expect(envelope.installationName).toBe(INSTALL_NAME)
  expect(envelope.snapshots?.length).toBe(1)
  // The first row in the picker is the newest snapshot — second-seeded
  // by our seed order — so the envelope must carry its label + commit.
  expect(envelope.snapshots?.[0]?.label).toBe('second-seeded')
  expect(envelope.snapshots?.[0]?.comfyui?.commit).toBe(COMMIT_B)
})

test('Export All writes an envelope containing every seeded snapshot @lifecycle', async () => {
  const popup = await openSnapshotsTab()

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

  const content = await readFile(exportedPath, 'utf-8')
  const envelope = JSON.parse(content) as {
    type?: string
    installationName?: string
    snapshots?: Array<{ label?: string }>
  }
  expect(envelope.type).toBe('comfyui-desktop-2-snapshot')
  expect(envelope.installationName).toBe(INSTALL_NAME)
  expect(envelope.snapshots?.length).toBe(2)
  // Both seeded labels must appear regardless of order (listSnapshots
  // sorts newest first; the seed timestamps land within milliseconds).
  const labels = envelope.snapshots?.map((s) => s.label) ?? []
  expect(labels).toContain('first-seeded')
  expect(labels).toContain('second-seeded')
})
