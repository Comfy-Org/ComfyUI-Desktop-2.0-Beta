/**
 * Lifecycle E2E: Desktop 1.x → Standalone migration trigger wiring.
 *
 * Pre-stages a Legacy Desktop layout on disk (Windows only — detection on
 * macOS reads `~/Library/Application Support/ComfyUI` from the real OS
 * home, and Linux has no Legacy Desktop path at all) so the launcher's
 * auto-tracker registers a `sourceId: 'desktop'` install on boot. The
 * test then exercises the migration trigger surface:
 *   - the auto-tracker actually creates the desktop install record
 *   - `previewDesktopMigration` stages a snapshot envelope from the
 *     legacy install (the SCAN phase of `migrate-to-standalone`)
 *   - the standalone source advertises a release + CPU variant the
 *     migration target picker would consume
 *
 * The download / extract / setup phase of `migrate-to-standalone` itself
 * is left to the existing `lifecycle.test.ts` standalone install path,
 * which already exercises the same `standaloneSource.install + postInstall`
 * code at the same cost.
 */

import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'

let ctx: AppContext
let legacyBasePath: string
let legacyInstallId = ''
let stagedSnapshotPath = ''

const LEGACY_NAME = 'ComfyUI Legacy Desktop'

interface FieldOption {
  value: string
  label: string
  recommended?: boolean
  [key: string]: unknown
}

interface Installation {
  id: string
  name: string
  sourceId: string
  installPath?: string
  [key: string]: unknown
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(process.platform !== 'win32', 'Legacy Desktop detection sandbox only works on Windows (APPDATA-based)')
  // Recreate lifecycle.test.ts's depth-search so this test works whether
  // it's run from the launcher repo or from the multi-repo workspace.
  if (!process.env['GITHUB_TOKEN']) {
    for (let depth = 2; depth <= 8; depth++) {
      const segments = Array(depth).fill('..')
      const p = resolve(__dirname, ...segments, 'githubtoken.txt')
      try { process.env['GITHUB_TOKEN'] = readFileSync(p, 'utf-8').trim(); break } catch { /* try next depth */ }
    }
  }

  legacyBasePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-legacy-desktop-e2e-'))
  // Layout `detectDesktopInstall` recognizes: models/ + user/ + .venv/.
  // Empty dirs are enough — captureDesktopSnapshot tolerates missing
  // python and an empty custom_nodes/ directory.
  await mkdir(path.join(legacyBasePath, 'models'), { recursive: true })
  await mkdir(path.join(legacyBasePath, 'user'), { recursive: true })
  await mkdir(path.join(legacyBasePath, 'input'), { recursive: true })
  await mkdir(path.join(legacyBasePath, 'output'), { recursive: true })
  await mkdir(path.join(legacyBasePath, '.venv'), { recursive: true })

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    async onSetup({ homeDir }) {
      // Write the legacy Desktop config.json the auto-tracker reads at
      // boot. On Windows it lives under %APPDATA%/ComfyUI/, which the
      // harness already sandboxes via the APPDATA env override.
      const desktopConfigDir = path.join(homeDir, 'AppData', 'Roaming', 'ComfyUI')
      await mkdir(desktopConfigDir, { recursive: true })
      await writeFile(
        path.join(desktopConfigDir, 'config.json'),
        JSON.stringify({ basePath: legacyBasePath }),
      )
    },
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (legacyBasePath) await rm(legacyBasePath, { recursive: true, force: true })
  if (stagedSnapshotPath) await rm(stagedSnapshotPath, { force: true })
})

test('auto-tracker registers Legacy Desktop install on boot @ci', async () => {
  await ctx.panel.waitFor(
    async () => {
      const names = await ctx.panel.allText(
        '.chooser-tile:not(.chooser-tile-new):not(.chooser-tile-cloud) .chooser-tile-name',
      )
      return names.includes(LEGACY_NAME)
    },
    { timeout: 15_000, message: 'auto-tracked Legacy Desktop tile never appeared in chooser' },
  )

  const installs = await ctx.panel.evaluate<Installation[]>(`window.api.getInstallations()`)
  const desktop = installs.find((i) => i.sourceId === 'desktop')
  expect(desktop, 'desktop install not present in get-installations result').toBeDefined()
  expect(desktop!.installPath).toBe(legacyBasePath)
  // Capture the auto-allocated id so subsequent tests can drive runAction
  // / previewDesktopMigration against the correct record.
  legacyInstallId = desktop!.id
})

test('preview-desktop-migration stages a snapshot envelope from the legacy install @ci', async () => {
  expect(legacyInstallId, 'legacyInstallId not captured by the prior test').toBeTruthy()
  const result = await ctx.panel.evaluate<{
    ok: boolean
    message?: string
    snapshotPath?: string
    preview?: { snapshotCount: number }
  }>(
    `window.api.previewDesktopMigration()`,
  )
  expect(result.ok, `previewDesktopMigration failed: ${result.message ?? ''}`).toBe(true)
  expect(result.snapshotPath, 'preview did not return a staged snapshot file').toBeTruthy()
  expect(await pathExists(result.snapshotPath!), 'staged snapshot file missing on disk').toBe(true)
  expect(result.preview?.snapshotCount).toBe(1)
  // Track for afterAll cleanup — the handler only auto-deletes the
  // previous file on its NEXT invocation, so a one-shot test leaks it.
  stagedSnapshotPath = result.snapshotPath!
})

test('standalone source exposes a CPU variant the migration target picker can pin @ci', async () => {
  // The renderer-side migration target picker calls these same field-option
  // IPCs to build its release / variant rows. The CI lifecycle suite pins
  // CPU on Windows; without that pick we'd download a GPU payload that
  // blows the budget. Asserting the pick is reachable here guards the
  // upstream R2 contract (`latest.json` + per-vendor `releases.json`)
  // the picker depends on.
  const releaseOptions = await ctx.panel.evaluate<FieldOption[]>(
    `window.api.getFieldOptions('standalone', 'release', {})`,
  )
  expect(releaseOptions.length, 'no standalone releases available').toBeGreaterThan(0)
  const release = releaseOptions.find((r) => r.recommended) ?? releaseOptions[0]!

  const variantOptions = await ctx.panel.evaluate<FieldOption[]>(
    `window.api.getFieldOptions('standalone', 'variant', ${JSON.stringify({ release })})`,
  )
  expect(variantOptions.length, 'no standalone variants available').toBeGreaterThan(0)
  const cpuVariant = variantOptions.find((v) => /cpu/i.test(v.value))
  expect(cpuVariant, `no CPU variant exposed for release ${release.value}: ${JSON.stringify(variantOptions.map((v) => v.value))}`).toBeDefined()
  expect(legacyInstallId, 'legacyInstallId not captured by the prior test').toBeTruthy()
})
