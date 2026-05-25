/**
 * Lifecycle E2E: Add Existing (track an externally-staged install).
 *
 * Pre-stages a standalone-shaped ComfyUI directory on disk (real git init
 * + tagged commit, empty `standalone-env/`, `ComfyUI/main.py`, a manifest)
 * and drives the importer through the underlying IPC contract:
 *   `probeInstallation(dir)` → renderer-side source pick →
 *   `trackInstallation({ ...probe, installPath, name })`.
 *
 * The IPC bypass mirrors what `TrackModal.vue` does internally; the UI
 * surface is covered by the chooser test. The point here is to lock down
 * the wiring that turns a folder on disk into a chooser tile whose
 * resolved `comfyVersion` reflects the staged git ref.
 */

import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'

let ctx: AppContext
let stagedPath: string

const TRACKED_NAME = 'Pre-Staged Install'

interface ProbeResult {
  sourceId: string
  sourceLabel: string
  version?: string
  commit?: string
  comfyVersion?: { commit: string; baseTag?: string; commitsAhead?: number }
  [key: string]: unknown
}

interface TrackResult {
  ok: boolean
  message?: string
  entry?: { id: string; name: string; installPath: string; sourceId: string }
}

interface Installation {
  id: string
  name: string
  installPath: string
  sourceId: string
  comfyVersion?: { commit: string; baseTag?: string; commitsAhead?: number }
  version?: string
  [key: string]: unknown
}

function gitIn(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Lifecycle Test',
      GIT_AUTHOR_EMAIL: 'lifecycle@example.com',
      GIT_COMMITTER_NAME: 'Lifecycle Test',
      GIT_COMMITTER_EMAIL: 'lifecycle@example.com',
    },
    stdio: 'pipe',
  })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  stagedPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-add-existing-e2e-'))
  const comfyuiDir = path.join(stagedPath, 'ComfyUI')
  await mkdir(comfyuiDir, { recursive: true })
  await mkdir(path.join(stagedPath, 'standalone-env'), { recursive: true })
  await writeFile(path.join(comfyuiDir, 'main.py'), '# placeholder for probe\n')
  // Standalone probe reads manifest.json from the install root for the
  // ref / releaseTag / variant / pythonVersion fields. Values don't drive
  // the assertion here — they exist so the renderer-facing payload is
  // populated end-to-end the way a real install would be.
  await writeFile(
    path.join(stagedPath, 'manifest.json'),
    JSON.stringify({
      comfyui_ref: 'main',
      version: 'v0.3.10',
      id: 'win-cpu',
      python_version: '3.12',
    }),
  )

  gitIn(comfyuiDir, ['init', '--quiet', '--initial-branch=main'])
  await writeFile(path.join(comfyuiDir, '.gitignore'), '')
  gitIn(comfyuiDir, ['add', '.'])
  gitIn(comfyuiDir, ['commit', '--quiet', '-m', 'staged commit'])

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (stagedPath) await rm(stagedPath, { recursive: true, force: true })
})

test('probe detects the staged standalone-shaped directory @lifecycle', async () => {
  const results = await ctx.panel.evaluate<ProbeResult[]>(
    `window.api.probeInstallation(${JSON.stringify(stagedPath)})`,
  )
  const standalone = results.find((r) => r.sourceId === 'standalone')
  expect(standalone, `probe did not detect standalone source. got: ${JSON.stringify(results)}`).toBeDefined()
  // The standalone probe attaches a resolved `comfyVersion` whenever the
  // ComfyUI/.git dir is reachable. Without it the tile would fall back to
  // the manifest's `comfyui_ref` string.
  expect(standalone!.comfyVersion?.commit).toMatch(/^[0-9a-f]{40}$/)
})

test('track-installation registers the directory and chooser shows the tile @lifecycle', async () => {
  const probeResults = await ctx.panel.evaluate<ProbeResult[]>(
    `window.api.probeInstallation(${JSON.stringify(stagedPath)})`,
  )
  const probe = probeResults.find((r) => r.sourceId === 'standalone')!
  const trackPayload = {
    name: TRACKED_NAME,
    installPath: stagedPath,
    ...probe,
  }
  const result = await ctx.panel.evaluate<TrackResult>(
    `window.api.trackInstallation(${JSON.stringify(trackPayload)})`,
  )
  expect(result.ok, `trackInstallation failed: ${result.message ?? ''}`).toBe(true)
  expect(result.entry?.installPath).toBe(stagedPath)

  await ctx.panel.waitFor(
    async () =>
      (await ctx.panel.allText(
        '.chooser-tile:not(.chooser-tile-new):not(.chooser-tile-cloud) .chooser-tile-name',
      )).includes(TRACKED_NAME),
    { timeout: 10_000, message: 'tracked install never appeared in chooser' },
  )

  const installs = await ctx.panel.evaluate<Installation[]>(
    `window.api.getInstallations()`,
  )
  const tracked = installs.find((i) => i.name === TRACKED_NAME)
  expect(tracked, 'tracked install not present in get-installations result').toBeDefined()
  expect(tracked!.sourceId).toBe('standalone')
  // Renderer-facing `version` is derived from the resolved comfyVersion via
  // `enrichInstallationsForRenderer`; with git present it should not fall
  // back to the raw sourceId string.
  expect(tracked!.version, 'version label missing from renderer payload').toBeTruthy()
  expect(tracked!.version).not.toBe('standalone')
})
