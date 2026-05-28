/**
 * Lifecycle E2E: periodic background poll keeps the ComfyUI release
 * cache fresh.
 *
 * Beyond the startup pre-warm (`runStartupReleaseChecks` triggered by
 * the first `get-installations` IPC), the launcher also starts a
 * background timer in main that re-runs the release fetch on a fixed
 * cadence. Without this, a user who leaves the launcher open for
 * hours would never see a newly-published upstream release in the
 * dashboard / title-bar pills.
 *
 * The default cadence is 15 minutes — too long for a real lifecycle
 * test. We override it via `E2E_PERIODIC_RECHECK_MS` to a value
 * comfortably above the release cache's 10s `MIN_RECHECK_INTERVAL`
 * (which would otherwise short-circuit the second fetch).
 *
 * The test seeds an install, lets the initial pre-warm populate the
 * cache, then waits for the periodic timer to fire and asserts the
 * cache's `checkedAt` has actually advanced (proves the timer ran a
 * real second fetch, not just a cache hit).
 */

import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { getReleaseCacheCheckedAt } from './support/devHooks'

const PERIODIC_INTERVAL_MS = 12_000 // > releaseCache's 10s MIN_RECHECK_INTERVAL

let ctx: AppContext
let stagedInstallPath = ''

const INSTALL_ID = 'inst-periodic-update-check'

interface FieldOption {
  value: string
  label: string
  data?: { latestVersion?: string }
}
interface DetailField {
  id?: string
  options?: FieldOption[]
}
interface DetailSection {
  tab?: string
  fields?: DetailField[]
}

async function getStableLatestVersion(): Promise<string | undefined> {
  const sections = await ctx.panel.evaluate<DetailSection[]>(
    `window.api.getDetailSections(${JSON.stringify(INSTALL_ID)})`,
  )
  return sections
    .find((s) => s.tab === 'update')
    ?.fields?.find((f) => f.id === 'updateChannel')
    ?.options?.find((o) => o.value === 'stable')
    ?.data?.latestVersion
}

async function getCacheCheckedAt(): Promise<number | null> {
  return await getReleaseCacheCheckedAt(ctx.app, 'Comfy-Org/ComfyUI', 'stable')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  stagedInstallPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-periodic-update-e2e-'))
  await mkdir(path.join(stagedInstallPath, 'ComfyUI'), { recursive: true })

  // Inject the env override BEFORE launching so main's whenReady picks
  // it up when registering the periodic timer.
  process.env['E2E_PERIODIC_RECHECK_MS'] = String(PERIODIC_INTERVAL_MS)
  try {
    ctx = await launchApp({
      settings: { firstUseCompleted: true, telemetryEnabled: false },
      installations: [
        {
          id: INSTALL_ID,
          name: 'Periodic Update Check Test',
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
  } finally {
    delete process.env['E2E_PERIODIC_RECHECK_MS']
  }
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (stagedInstallPath) await rm(stagedInstallPath, { recursive: true, force: true })
})

test('background timer re-fetches the release cache on its interval @ci', async () => {
  test.setTimeout(60_000)

  // Wait for the initial IPC-hook pre-warm to populate the cache.
  // Once `latestVersion` matches a real upstream semver, we know the
  // first fetch landed.
  await expect
    .poll(async () => {
      const v = await getStableLatestVersion()
      return typeof v === 'string' && /v\d+\.\d+/.test(v)
    }, { timeout: 30_000, intervals: [500, 1_000, 2_000] })
    .toBe(true)

  // Capture the checkedAt the initial fetch stamped.
  const firstCheckedAt = await getCacheCheckedAt()
  expect(firstCheckedAt, 'cache.stable.checkedAt missing after initial pre-warm').toBeTruthy()

  // Wait one interval + buffer for the periodic timer to fire AND for
  // the fetch to land. The 10s MIN_RECHECK_INTERVAL inside getOrFetch
  // means we MUST wait at least 10s past the initial fetch before the
  // periodic tick's force=true will result in a real re-fetch.
  await new Promise((r) => setTimeout(r, PERIODIC_INTERVAL_MS + 5_000))

  const secondCheckedAt = await getCacheCheckedAt()
  expect(
    secondCheckedAt,
    `periodic timer did not advance checkedAt: initial=${firstCheckedAt}, after one interval+buffer=${secondCheckedAt}`,
  ).toBeGreaterThan(firstCheckedAt!)
})
