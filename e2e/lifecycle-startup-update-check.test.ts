/**
 * Lifecycle E2E: startup-time release-cache pre-warm.
 *
 * On cold start with an installed install, main fires a background
 * `runStartupReleaseChecks` against the real Comfy-Org/ComfyUI
 * remote — one `git ls-remote --tags` per unique channel in use —
 * so the dashboard / title-bar update pills reflect upstream state
 * without the user navigating to the picker's Update tab.
 *
 * Verified by asserting the channel-cards `data.checkedAt` payload
 * appears in `getDetailSections` within seconds of the chooser
 * mounting. No `runAction('check-update')` is invoked from the test,
 * and no UI gesture (picker open, tab click) is dispatched — if main
 * didn't pre-warm on startup the cache would stay empty and the
 * picker option's `data` would be `undefined`.
 *
 * Cost: one cheap `git ls-remote` to github.com per startup. Single-
 * flight + 10s `MIN_RECHECK_INTERVAL` inside `releaseCache.getOrFetch`
 * back-stop accidental double-fires.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'

let ctx: AppContext
let stagedInstallPath = ''

const INSTALL_ID = 'inst-startup-update-check'
const INSTALL_NAME = 'Startup Update Check Test'

interface FieldOption {
  value: string
  label: string
  data?: { latestVersion?: string; updateAvailable?: boolean }
}

interface DetailField {
  id?: string
  value?: unknown
  options?: FieldOption[]
}

interface DetailSection {
  tab?: string
  fields?: DetailField[]
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  stagedInstallPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-startup-update-e2e-'))
  // `ComfyUI/` existence gates several detail-section branches. The
  // startup pre-warm itself only needs the install record + channel;
  // the directory keeps `getDetailSections` happy when we poll for
  // the populated cache.
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
        comfyVersion: { commit: 'a'.repeat(40), baseTag: 'v0.1.0', commitsAhead: 0 },
        releaseTag: 'v0.1.0',
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

test('startup pre-warm fills the release cache without any UI gesture @lifecycle', async () => {
  test.setTimeout(60_000)

  // Poll the detail-sections payload — same pipeline the dashboard
  // pill reads via `source.getStatusTag(installation)`. If the startup
  // pre-warm fired, the `stable` channel option's `data` payload will
  // contain a `latestVersion` populated from the real Comfy-Org remote
  // and an `updateAvailable` of `true` (the seeded comfyVersion is
  // pinned at v0.1.0 so anything currently published reads as newer).
  // Without the pre-warm `data` is `undefined` (no cache entry).
  await expect
    .poll(async () => {
      const sections = await ctx.panel.evaluate<DetailSection[]>(
        `window.api.getDetailSections(${JSON.stringify(INSTALL_ID)})`,
      )
      const updateSection = sections.find((s) => s.tab === 'update')
      const channelField = updateSection?.fields?.find((f) => f.id === 'updateChannel')
      const stableCard = channelField?.options?.find((o) => o.value === 'stable')
      const data = stableCard?.data
      return !!data && typeof data.latestVersion === 'string' && /v\d+\.\d+/.test(data.latestVersion)
    }, { timeout: 30_000, intervals: [500, 1_000, 2_000] })
    .toBe(true)

  // Sanity: the seeded comfyVersion is pinned at v0.1.0 — anything
  // currently-published is newer, so the dashboard pill predicate
  // (`updateAvailable`) MUST be true once the cache is populated.
  const sections = await ctx.panel.evaluate<DetailSection[]>(
    `window.api.getDetailSections(${JSON.stringify(INSTALL_ID)})`,
  )
  const stableCard = sections
    .find((s) => s.tab === 'update')!
    .fields!.find((f) => f.id === 'updateChannel')!
    .options!.find((o) => o.value === 'stable')!
  expect(
    stableCard.data?.updateAvailable,
    'startup pre-warm fetched releases but isUpdateAvailable still false',
  ).toBe(true)
})
