/**
 * Lifecycle E2E: per-install Snapshots tab.
 *
 * - Seeds a single installation plus one snapshot JSON file on disk, then
 *   opens the instance picker directly into the Snapshots tab and asserts
 *   the row renders the backend-formatted `comfyuiVersion` string verbatim
 *   (regression for the `formatComfyVersion` short-style path).
 * - Captures a fresh snapshot via `runAction('snapshot-save')` and asserts
 *   a new row appears at the top of the timeline.
 *
 * Restore is intentionally out of scope here — the live op runs real git
 * checkout, custom-node clone, and pip ops, none of which the seeded
 * harness has set up. Cover restore in a separate test with a pre-staged
 * git repo or a dev-hook stub.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { titlePopupPage } from './support/cdpPages'

let ctx: AppContext

const INSTALL_ID = 'inst-snapshot-test'
const INSTALL_NAME = 'Snapshot Test Install'
const SEEDED_COMMIT = 'a'.repeat(40)
const SEEDED_BASE_TAG = 'v0.3.10'
const SEEDED_COMMITS_AHEAD = 2
const EXPECTED_VERSION = `${SEEDED_BASE_TAG}+${SEEDED_COMMITS_AHEAD}`

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Use an explicit installPath outside the harness home dir so we can
  // assert against the snapshot files we wrote without round-tripping
  // through `app.getPath('userData')`.
  const installPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-e2e-'))
  // saveSnapshot scans `<installPath>/ComfyUI/custom_nodes` and reads
  // git head; both tolerate missing dirs, but materializing the parent
  // keeps the capture path off the slow-stat error branch on Windows.
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
            label: 'seeded',
            comfyui: {
              ref: SEEDED_COMMIT,
              commit: SEEDED_COMMIT,
              releaseTag: SEEDED_BASE_TAG,
              variant: 'cpu',
              baseTag: SEEDED_BASE_TAG,
              commitsAhead: SEEDED_COMMITS_AHEAD,
            },
          },
        ],
      },
    ],
  })
})

test.afterAll(async () => {
  await ctx.cleanup()
})

test('seeded snapshot row renders the backend-formatted version @lifecycle', async () => {
  const opened = await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        mode: 'expanded',
        initialTab: 'snapshots',
      })
      return true
    })()`,
  )
  expect(opened).toBe(true)

  const popup = titlePopupPage(ctx.app)
  await popup.waitForVisible('.snapshot-row', { timeout: 15_000 })

  const metaText = await popup.textOf('.snapshot-row-meta')
  expect(metaText, 'snapshot meta line not rendered').not.toBeNull()
  expect(metaText!).toContain(EXPECTED_VERSION)
})

test('captures a new snapshot via runAction and shows it at the top @lifecycle', async () => {
  const before = await ctx.panel.evaluate<number>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.length)`,
  )
  expect(before).toBe(1)

  await ctx.panel.evaluate<unknown>(
    `window.api.runAction(${JSON.stringify(INSTALL_ID)}, 'snapshot-save', { label: 'captured-by-test' })`,
  )

  await expect
    .poll(
      async () =>
        ctx.panel.evaluate<number>(
          `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.length)`,
        ),
      { timeout: 15_000, intervals: [250, 500] },
    )
    .toBe(2)

  const labels = await ctx.panel.evaluate<Array<string | null>>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)}).then(d => d.snapshots.map(s => s.label))`,
  )
  expect(labels[0]).toBe('captured-by-test')
})
