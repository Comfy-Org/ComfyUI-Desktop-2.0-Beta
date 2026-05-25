/**
 * Lifecycle E2E: real `check-update` against the live Comfy-Org/ComfyUI
 * git remote.
 *
 * Pre-stages a fake standalone install record pinned to an OLD baseTag,
 * then drives `runAction('check-update')` and asserts that the release
 * cache picked up the current latest tag from GitHub and the channel
 * cards report an update is available.
 *
 * This is intentionally a network-touching test: it is the only e2e
 * proof that `fetchLatestRelease` (`git ls-remote --tags`) and the
 * release cache → channel-cards pipeline actually wire up against the
 * real upstream. No HTTP mocks, no dev-hook state injection — if
 * github.com or Comfy-Org/ComfyUI changes shape, this test catches it.
 *
 * Cost: one `git ls-remote --tags` to github.com (~tens of KB).
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

let ctx: AppContext
let stagedInstallPath = ''

const INSTALL_ID = 'inst-update-check'
const INSTALL_NAME = 'Update Check Test'
// An intentionally old baseTag so any currently-published stable release
// reads as "newer". v0.1.0 is from June 2024; anything from H2-2024 onward
// will compare strictly greater under semver string ordering on the
// channel card.
const SEEDED_BASE_TAG = 'v0.1.0'
const SEEDED_COMMIT = 'a'.repeat(40)

interface FieldOption {
  value: string
  label: string
  data?: {
    installedVersion: string
    latestVersion: string
    lastChecked: string
    updateAvailable: boolean
  }
}

interface DetailField {
  id?: string
  label?: string
  value?: unknown
  options?: FieldOption[]
}

interface DetailSection {
  tab?: string
  title?: string
  fields?: DetailField[]
  actions?: unknown[]
}

interface RunActionResult {
  ok: boolean
  message?: string
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  stagedInstallPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-update-check-e2e-'))
  // ComfyUI/ existence gates several detail-section branches (e.g. `hasGit`).
  // We don't need a real clone for this test — the check-update path itself
  // only requires it for `enrichCommitsAhead`, which no-ops without a .git
  // dir. The release-cache fetch + channel-card comparison both run.
  await mkdir(path.join(stagedInstallPath, 'ComfyUI'), { recursive: true })

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID,
        name: INSTALL_NAME,
        installPath: stagedInstallPath,
        sourceId: 'standalone',
        status: 'installed',
        updateChannel: 'stable',
        comfyVersion: { commit: SEEDED_COMMIT, baseTag: SEEDED_BASE_TAG, commitsAhead: 0 },
        // Match the renderer-visible shape so the picker behaves as if this
        // record came out of the real installer.
        releaseTag: SEEDED_BASE_TAG,
        variant: 'cpu',
        pythonVersion: '3.12',
      },
    ],
  })
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (stagedInstallPath) await rm(stagedInstallPath, { recursive: true, force: true })
})

test('check-update hits the real Comfy-Org/ComfyUI remote and finds a newer release @lifecycle', async () => {
  const result = await ctx.panel.evaluate<RunActionResult>(
    `window.api.runAction(${JSON.stringify(INSTALL_ID)}, 'check-update')`,
  )
  expect(result.ok, `check-update failed (network/auth issue?): ${result.message ?? ''}`).toBe(true)

  // After check-update the channel cards should expose the latest stable
  // release the remote actually serves. Read it back via getDetailSections
  // — same path the renderer uses for the Update tab.
  const sections = await ctx.panel.evaluate<DetailSection[]>(
    `window.api.getDetailSections(${JSON.stringify(INSTALL_ID)})`,
  )
  const updateSection = sections.find((s) => s.tab === 'update')
  expect(updateSection, 'no update section in detail sections').toBeDefined()
  const channelField = updateSection!.fields!.find((f) => f.id === 'updateChannel')
  expect(channelField?.options, 'update channel field missing options').toBeDefined()
  const stableCard = channelField!.options!.find((o) => o.value === 'stable')
  expect(stableCard, 'stable channel card missing').toBeDefined()
  expect(stableCard!.data, 'stable channel card has no data — release cache empty?').toBeDefined()

  // The latest stable tag advertised by the remote should look like a real
  // semver-ish ComfyUI tag (e.g. v0.3.59). Don't pin a specific value;
  // the upstream ships releases continuously.
  expect(stableCard!.data!.latestVersion, 'latest stable version not populated from remote').toMatch(/v\d+\.\d+/)
  // The seeded comfyVersion is at v0.1.0 — anything currently-published is
  // newer, so the channel card should report an update available.
  expect(
    stableCard!.data!.updateAvailable,
    `stable card did not flag update available against seeded baseTag ${SEEDED_BASE_TAG}; got latestVersion=${stableCard!.data!.latestVersion}`,
  ).toBe(true)
})

test('cross-channel fetch populates the latest channel card too @lifecycle', async () => {
  // The check-update action prefetches the "other" channel(s) in parallel
  // (Promise.allSettled over `['stable', 'latest']`). The previous test
  // already ran check-update — now verify both cards have data, not just
  // the current channel.
  const sections = await ctx.panel.evaluate<DetailSection[]>(
    `window.api.getDetailSections(${JSON.stringify(INSTALL_ID)})`,
  )
  const updateSection = sections.find((s) => s.tab === 'update')!
  const channelField = updateSection.fields!.find((f) => f.id === 'updateChannel')!
  const latestCard = channelField.options!.find((o) => o.value === 'latest')
  expect(latestCard?.data, 'latest channel card has no data — cross-channel prefetch did not run').toBeDefined()
  // The latest channel uses the master HEAD short SHA as its "tag", not a
  // semver. Just assert it's a non-empty version string with a SHA-ish shape
  // (7+ hex chars somewhere in the rendered version).
  expect(latestCard!.data!.latestVersion).toMatch(/[a-f0-9]{7,}/)
})
