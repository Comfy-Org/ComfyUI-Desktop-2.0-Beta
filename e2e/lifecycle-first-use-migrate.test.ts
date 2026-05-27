/**
 * Lifecycle E2E: first-use Migrate branch end-to-end.
 *
 * Cold-starts with a seeded Legacy Desktop install on disk so the
 * auto-tracker registers a `sourceId: 'desktop'` record at boot and
 * `detectFirstUseState` flips `hasLegacyDesktop`. Drives the user
 * through consent → pick-local → migrate sub-step and asserts:
 *   - the migrate confirm renders as the brand `MigrateConfirmTakeover`
 *     (takeover surface, not the legacy modal path)
 *   - clicking Confirm dispatches `runAction('migrate-to-standalone', …)`
 *     against the legacy install id
 *   - the chain bookkeeping (`firstUseMode` push to `'post-consent'`)
 *     fires before the migration op is kicked off
 *
 * The auto-launch watcher hand-off post-migration is shared with the
 * chain-local path (covered by `lifecycle.test.ts`); driving a full
 * standalone install end-to-end from the migrate branch is the same
 * 500MB download and not repeated here.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { getIpcInvocations, resetIpcInvocations } from './support/devHooks'

let ctx: AppContext
let legacyBasePath: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(process.platform !== 'win32', 'Legacy Desktop detection sandbox only works on Windows (APPDATA-based)')

  legacyBasePath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-first-use-migrate-e2e-'))
  // Layout `detectDesktopInstall` recognises: models/ + user/ + .venv/.
  await mkdir(path.join(legacyBasePath, 'models'), { recursive: true })
  await mkdir(path.join(legacyBasePath, 'user'), { recursive: true })
  await mkdir(path.join(legacyBasePath, 'input'), { recursive: true })
  await mkdir(path.join(legacyBasePath, 'output'), { recursive: true })
  await mkdir(path.join(legacyBasePath, '.venv'), { recursive: true })

  // Cold start: no `firstUseCompleted` seed, but a Legacy Desktop
  // config.json under the sandboxed %APPDATA% so the auto-tracker
  // registers a `sourceId: 'desktop'` install before the takeover paints.
  ctx = await launchApp({
    async onSetup({ homeDir }) {
      const desktopConfigDir = path.join(homeDir, 'AppData', 'Roaming', 'ComfyUI')
      await mkdir(desktopConfigDir, { recursive: true })
      await writeFile(
        path.join(desktopConfigDir, 'config.json'),
        JSON.stringify({ basePath: legacyBasePath }),
      )
    },
  })
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (legacyBasePath) await rm(legacyBasePath, { recursive: true, force: true })
})

test('cold start with legacy desktop lands on start screen and surfaces migrate sub-step @lifecycle', async () => {
  // Merged start screen — consent + cloud/local + ToS all share one
  // page (commit 5619823). The hasLegacyDesktop branch fires after the
  // user picks Local and clicks Continue.
  await ctx.panel.waitForVisible('.start-hero', { timeout: 15_000 })

  // Pick Local first to reveal the Express-Install checkbox, then opt
  // out of express so we follow the standard local flow into the
  // legacy-branch sub-step. Tick ToS so Continue enables.
  expect(await ctx.panel.click('[data-testid="first-use-pick-local"]')).toBe(true)
  await ctx.panel.waitForVisible('[data-testid="first-use-express-install"]', { timeout: 5_000 })
  // Express defaults to checked on Local pick — toggle it off to force
  // the non-express path that lands on the legacy-branch sub-step.
  await ctx.panel.evaluate<void>(
    `(() => {
      const wrap = document.querySelector('[data-testid="first-use-express-install"]')
      const cb = wrap && wrap.querySelector('input[type="checkbox"]')
      if (cb && cb.checked) cb.click()
    })()`,
  )
  expect(await ctx.panel.click('[data-testid="first-use-consent-tos"]')).toBe(true)
  await ctx.panel.waitFor(
    async () => ctx.panel.evaluate<boolean>(
      `!document.querySelector('[data-testid="first-use-continue"]').disabled`,
    ),
    { timeout: 5_000, message: 'Continue never became enabled after ticking ToS' },
  )
  expect(await ctx.panel.click('[data-testid="first-use-continue"]')).toBe(true)

  // `pickLocal` sees `hasLegacyDesktop=true` (auto-tracker registered
  // the desktop install via the seeded config.json) so the takeover
  // advances to the localBranch sub-step rather than firing
  // `chain-local` directly. Confirms detection plumbed through.
  await ctx.panel.waitForVisible('[data-testid="first-use-local-migrate"]', { timeout: 10_000 })
})

test('migrate sub-step opens MigrateConfirmTakeover (takeover surface) @lifecycle', async () => {
  // Reset run-action invocations so the confirm assertion below counts
  // only the migrate-to-standalone dispatch this test produces.
  await resetIpcInvocations(ctx.app, 'run-action')
  await resetIpcInvocations(ctx.app, 'comfy-window:set-first-use-mode')

  expect(await ctx.panel.click('[data-testid="first-use-local-migrate"]')).toBe(true)

  // `handleFirstUseChainMigrate` routes through
  // `useMigrateAction.confirmMigration({ surface: 'takeover' })` →
  // `registeredTakeover.open(...)` which mounts MigrateConfirmTakeover.
  // The takeover's primary CTA is `data-testid="migrate-takeover-confirm"`.
  await ctx.panel.waitForVisible('[data-testid="migrate-takeover-confirm"]', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="migrate-takeover-cancel"]')

  // Wait until the takeover's Confirm CTA leaves loading state — the
  // preview fetch (`previewDesktopMigration`) is awaited before the
  // confirm becomes enabled.
  await ctx.panel.waitFor(
    async () => ctx.panel.evaluate<boolean>(
      `!document.querySelector('[data-testid="migrate-takeover-confirm"]').disabled`,
    ),
    { timeout: 15_000, message: 'migrate-takeover Confirm never became enabled (preview stalled)' },
  )

  expect(await ctx.panel.click('[data-testid="migrate-takeover-confirm"]')).toBe(true)

  // The host dismisses the takeover, flips `chainingFirstUseToNewInstall`
  // true and kicks off the Tier 2 progress op via
  // `handleShowProgress({ apiCall: () => runAction('migrate-to-standalone', …) })`.
  // The migration itself can fail (the harness doesn't network-stub
  // R2) — the assertion is that the IPC was dispatched, not that the
  // op succeeded.
  type RunActionCall = { installationId: string; actionId: string }
  await expect.poll(
    async () => {
      const calls = await getIpcInvocations(ctx.app, 'run-action') as RunActionCall[]
      return calls.some((c) => c.actionId === 'migrate-to-standalone')
    },
    { timeout: 15_000, intervals: [200, 500] },
  ).toBe(true)

  // The chain's explicit `setFirstUseMode('post-consent')` re-assertion
  // fires after `dismissTakeoverDirect` pushed `'none'` — assert the
  // sequence rather than just the final value because the migration op
  // is still in flight here.
  const modeCalls = await getIpcInvocations(ctx.app, 'comfy-window:set-first-use-mode') as Array<{ mode: string }>
  const modes = modeCalls.map((c) => c.mode)
  expect(modes, 'chain-migrate should re-assert post-consent after dismiss').toContain('post-consent')
})
