/**
 * Lifecycle E2E: snapshot "Share" — the promoted top-level export of an
 * install's LATEST snapshot, reachable from two surfaces:
 *
 *   - **Dashboard tile kebab → Share** — the `share` context-menu item
 *     in `useInstallContextMenu`; handled renderer-side in the panel
 *     webContents (no confirm modal): `shareLatestSnapshot` →
 *     `window.api.getSnapshots` (newest = `[0]`) → `window.api.exportSnapshot`.
 *   - **Picker footer "More" → Share** — the `share` pin-bottom action in
 *     the standalone source's `getDetailSections`, rendered in the
 *     instance-picker popup's `MoreMenu` and intercepted in
 *     `useComfyUISettings.runAction` so it runs the same export rather than
 *     dispatching a (non-existent) source action.
 *
 * Both routes funnel into the same `export-snapshot` IPC →
 * `dialog.showSaveDialog` → `writeFile(envelope)`. The native save dialog
 * is monkey-patched (as in `lifecycle-snapshot-export`) so it never opens;
 * the stub writes into the test's tmp dir and the assertions read the JSON
 * to confirm the envelope carries exactly the newest snapshot.
 *
 * Pins both entry points so a future menu / action refactor can't silently
 * drop Share from either surface, and so the "latest snapshot only"
 * contract can't regress into exporting the wrong (or every) snapshot.
 *
 * The snapshot records are seeded directly via `installations[].snapshots`
 * so the test does not depend on any real ComfyUI install on disk.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'
import { titlePopupPage, waitForWebContents } from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let installPath = ''
let exportDir = ''

const INSTALL_ID = 'inst-snapshot-share-test'
const INSTALL_NAME = 'Snapshot Share Test'
const COMMIT_OLD = 'a'.repeat(40)
const COMMIT_NEW = 'b'.repeat(40)
const BASE_TAG = 'v0.3.10'

interface ShareEnvelope {
  type?: string
  installationName?: string
  snapshots?: Array<{ label?: string; comfyui?: { commit?: string } }>
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-share-e2e-'))
  exportDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-share-out-'))
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
            label: 'older-seeded',
            createdAt: '2026-01-01T00:00:00.000Z',
            comfyui: {
              ref: COMMIT_OLD,
              commit: COMMIT_OLD,
              releaseTag: BASE_TAG,
              variant: 'cpu',
              baseTag: BASE_TAG,
              commitsAhead: 1,
            },
          },
          {
            trigger: 'manual',
            label: 'newest-seeded',
            createdAt: '2026-01-02T00:00:00.000Z',
            comfyui: {
              ref: COMMIT_NEW,
              commit: COMMIT_NEW,
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

  // Monkey-patch `dialog.showSaveDialog` in main so the native save dialog
  // never opens. Patching the shared `dialog` module covers both the panel
  // `export-snapshot` handler and the picker popup's delegating handler.
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

  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (installPath) await rm(installPath, { recursive: true, force: true })
  if (exportDir) await rm(exportDir, { recursive: true, force: true })
})

/** Empty the export dir before each Share click. Both surfaces export the
 *  same latest snapshot, so they land on an identical default filename —
 *  clearing first guarantees each test reads the file IT produced, not a
 *  stale one from the prior test. */
async function clearExportDir(): Promise<void> {
  const entries = await readdir(exportDir)
  await Promise.all(entries.map((e) => rm(path.join(exportDir, e), { force: true })))
}

/** Poll until the single-snapshot `snapshot-*.json` envelope lands (the
 *  `snapshots-*` plural prefix is Export-All, which Share never uses) and
 *  return it parsed. */
async function readSharedEnvelope(): Promise<ShareEnvelope> {
  const exportedPath = await new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const poll = async (): Promise<void> => {
      const entries = await readdir(exportDir)
      const match = entries.find((e) => e.startsWith('snapshot-') && e.endsWith('.json'))
      if (match) return resolve(path.join(exportDir, match))
      if (Date.now() > deadline) return reject(new Error('shared snapshot file did not appear within 10s'))
      setTimeout(poll, 200)
    }
    void poll()
  })
  return JSON.parse(await readFile(exportedPath, 'utf-8')) as ShareEnvelope
}

/** Share must export ONLY the newest snapshot (the current state), as a
 *  single-entry envelope. */
function expectLatestEnvelope(envelope: ShareEnvelope): void {
  expect(envelope.type).toBe('comfyui-desktop-2-snapshot')
  expect(envelope.installationName).toBe(INSTALL_NAME)
  expect(envelope.snapshots?.length).toBe(1)
  expect(envelope.snapshots?.[0]?.label).toBe('newest-seeded')
  expect(envelope.snapshots?.[0]?.comfyui?.commit).toBe(COMMIT_NEW)
}

test('dashboard kebab → Share exports the latest snapshot @lifecycle', async () => {
  await clearExportDir()
  await ctx.panel.waitForSelector(byTestId(TID.dashboardTile(INSTALL_ID)), { timeout: 10_000 })

  expect(await ctx.panel.click(byTestId(TID.dashboardTileKebab(INSTALL_ID)))).toBe(true)
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem('share')), { timeout: 5_000 })
  expect(await ctx.panel.click(byTestId(TID.contextMenuItem('share')))).toBe(true)

  expectLatestEnvelope(await readSharedEnvelope())
})

test('picker footer More → Share exports the latest snapshot @lifecycle', async () => {
  await clearExportDir()

  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        initialTab: 'config',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  // Open the footer "More" overflow menu, then click the Share action.
  await popup.waitForVisible('[data-more-trigger]', { timeout: 15_000 })
  expect(await popup.click('[data-more-trigger]')).toBe(true)
  await popup.waitForVisible(byTestId(TID.pinBottomAction('share')), { timeout: 10_000 })
  expect(await popup.click(byTestId(TID.pinBottomAction('share')))).toBe(true)

  expectLatestEnvelope(await readSharedEnvelope())
})
