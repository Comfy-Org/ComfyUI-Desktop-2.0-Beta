/**
 * Lifecycle E2E: New Install (recommended standalone variant for the host
 * GPU, latest stable release) → ComfyUI auto-launches via brand chrome →
 * dashboard return → relaunch → stop.
 *
 * Downloads ~500 MB of standalone payload. Tagged @lifecycle and runs under
 * the dedicated Playwright project (10-minute per-test timeout).
 *
 * Run:
 *   pnpm run build && pnpm run test:e2e:windows -- --project=lifecycle
 *
 * Requirements: network access, ~2 GB free disk.
 *
 * Redesign notes (vs. the pre-2.0-Beta lifecycle test):
 * - The new-install takeover is a single Configure screen wrapped in
 *   `BrandTakeoverLayout` (root: `.brand-takeover-root`). No multi-step
 *   wizard, no Next button.
 * - Standalone is pre-selected on open. `loadFieldOptions('release')`
 *   picks the recommended option ("Latest Stable") and recursively
 *   loads `loadFieldOptions('variant')` which picks its own recommended
 *   option (CPU on a no-GPU CI runner, NVIDIA on an NVIDIA box, etc.).
 *   So by the time `saveDisabled` flips false, the form is fully
 *   pre-filled — no explicit release / variant picking needed.
 * - The primary CTA is `.brand-primary.config-continue` labelled
 *   "Continue" (formerly `button.primary` "Add Install").
 * - `handleSave` emits `show-progress` with `autoLaunchOnFinish: true`,
 *   so the install op chains directly into a launch op under the same
 *   brand-takeover chrome. There is no intermediate "Done" button and
 *   no need to click the chooser tile to launch — the chooser host
 *   transforms in place into the install host (issue #449 path).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  clickInstallTile,
  expectChooserVisible,
  expectTakeoverOpen,
} from './support/chooserHelpers'
import {
  getIpcInvocations,
  getRunningSessionSnapshot,
  resetIpcInvocations,
  returnFirstInstallHostToDashboard,
} from './support/devHooks'
import {
  isPopupVisible,
  systemModalPage,
  titlePopupPage,
  waitForWebContents,
} from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  if (!process.env['GITHUB_TOKEN']) {
    for (let depth = 2; depth <= 8; depth++) {
      const segments = Array(depth).fill('..')
      const p = resolve(__dirname, ...segments, 'githubtoken.txt')
      try {
        process.env['GITHUB_TOKEN'] = readFileSync(p, 'utf-8').trim()
        break
      } catch { /* try next depth */ }
    }
  }
  // True cold start: no `firstUseCompleted` seed, so the host opens on
  // the first-use takeover. The first test below drives through consent
  // + pick-local, which chains directly into the new-install takeover
  // (Tier 3 → Tier 3 silent swap) — the same surface the user reaches
  // on the no-existing-installs cold-start path.
  ctx = await launchApp()
})

test.afterAll(async () => {
  await ctx.cleanup()
})

/** True iff a webContents with a localhost URL exists and is loaded. */
async function comfyFrontendIsLoaded(): Promise<boolean> {
  return ctx.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((wc) =>
      /^http:\/\/(127\.0\.0\.1|localhost):/.test(wc.getURL()) && !wc.isLoading(),
    ),
  )
}

// ---------------------------------------------------------------------------
// First-use takeover → New Install takeover
// ---------------------------------------------------------------------------

test('cold start lands on first-use consent screen @lifecycle', async () => {
  // The first-use takeover gates the chooser body until consent +
  // cloud/local pick are completed. On a fresh profile the consent
  // step is what the user lands on.
  await ctx.panel.waitForVisible('.consent-hero', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="first-use-accept-consent"]')
})

test('accept consent + pick local opens New Install takeover with form pre-filled @lifecycle', async () => {
  // Tick the required ToS checkbox (telemetry stays at its default
  // opt-in; the test settings already disable telemetry network egress
  // separately, so the actual value doesn't matter here).
  expect(await ctx.panel.click('[data-testid="first-use-consent-tos"]')).toBe(true)
  await ctx.panel.waitFor(
    async () => ctx.panel.evaluate<boolean>(
      `!document.querySelector('[data-testid="first-use-accept-consent"]').disabled`,
    ),
    { timeout: 5_000, message: 'Get Started never became enabled after ticking ToS' },
  )

  // Accept consent → advance to the cloud-vs-local pick step.
  expect(await ctx.panel.click('[data-testid="first-use-accept-consent"]')).toBe(true)
  await ctx.panel.waitForVisible('[data-testid="first-use-pick-local"]', { timeout: 10_000 })

  // Pick Local — with no legacy desktop install detected, this emits
  // `chain-local`, which the host swaps for the new-install Tier 3
  // takeover (silent Tier 3 → Tier 3 swap inside `useOverlay`).
  expect(await ctx.panel.click('[data-testid="first-use-pick-local"]')).toBe(true)
  await expectTakeoverOpen(ctx.panel)

  // Standalone is pre-selected on open. The release + variant fields
  // live inside the Advanced disclosure but are populated eagerly via
  // `loadFieldOptions('release')` → recursive `loadFieldOptions('variant')`.
  // `.brand-primary.config-continue` is bound to `:disabled="!canContinue"`,
  // so once it goes enabled the form is fully pre-filled (release picked,
  // variant picked, no path issues).
  await ctx.panel.waitFor(
    async () => ctx.app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
      if (!wc) return false
      return wc.executeJavaScript(`(() => {
        const btn = document.querySelector('.brand-primary.config-continue')
        return !!btn && !btn.disabled
      })()`) as Promise<boolean>
    }),
    { timeout: 60_000, message: 'Continue button never became enabled (form did not pre-fill)' },
  )

  // On Windows, force the CPU variant so the test is deterministic
  // across runners (NVIDIA hosts would otherwise download a multi-GB
  // GPU payload). macOS only publishes `mac-mps` and Linux publishes
  // no `linux-cpu` variant, so on those platforms we trust the
  // recommended pick the form already made.
  if (process.platform === 'win32') {
    // Variant rows live inside the Advanced disclosure; the body is
    // always rendered (CSS-hidden when collapsed), so clicking the
    // row works even without expanding — but expand anyway to mirror
    // the real user gesture.
    expect(await ctx.panel.click('.config-advanced__summary')).toBe(true)
    await ctx.panel.waitForSelector('.brand-variant-row', { timeout: 5_000 })
    expect(
      await ctx.panel.clickByText('.brand-variant-row', 'CPU'),
      'CPU variant row clicked',
    ).toBe(true)
    // Confirm the CPU row is the selected one before continuing —
    // otherwise a label-substring miss (e.g. an i18n change) would
    // silently fall back to the recommended GPU variant.
    await ctx.panel.waitFor(
      async () => ctx.panel.evaluate<boolean>(
        `(() => {
          const sel = document.querySelector('.brand-variant-row--selected .brand-variant-row__label')
          return !!sel && /CPU/i.test(sel.textContent || '')
        })()`,
      ),
      { timeout: 5_000, message: 'CPU variant did not become the selected variant row' },
    )
  }
})

test('completes install (auto-launches via brand chrome) @lifecycle', async () => {
  // No explicit variant / release / name picking — trust the
  // recommended defaults the modal has already filled in. On a no-GPU
  // CI runner that's CPU; on a GPU box it's the matching GPU variant.
  // Either is fine for the lifecycle smoke test.
  expect(await ctx.panel.clickByText('.brand-primary', 'Continue')).toBe(true)

  // Install op mounts the brand-progress takeover, then auto-launches
  // into a launch op under the same chrome. The terminal signal is
  // the comfy webContents loading a localhost URL — covers both the
  // install completing and the server coming up.
  await ctx.panel.waitForVisible('.brand-progress', { timeout: 10_000 })
  await expect.poll(comfyFrontendIsLoaded, { timeout: 480_000, intervals: [1_000, 2_000] }).toBe(true)
})

// ---------------------------------------------------------------------------
// Launch & verify split-view + dark background
// ---------------------------------------------------------------------------

test('auto-launch landed on a single host window (in-place attach) @lifecycle', async () => {
  // In-place attach guard: the redesigned install flow has
  // `autoLaunchOnFinish: true`, so the chooser host transforms into
  // the install host without spawning a fresh BrowserWindow. The
  // previous test already polled `comfyFrontendIsLoaded` to true — at
  // this point exactly one window should exist and it should host the
  // comfy webContents. A close+open swap path would leak windows or
  // leave the original chooser host alive alongside a new install host.
  const state = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return { count: wins.length, comfyHostId: comfyHost?.id ?? null }
  })
  expect(state.count).toBe(1)
  expect(state.comfyHostId).not.toBeNull()
})

/**
 * Regression guard for #449: per-install BrowserWindow uses the title-bar +
 * content split-view (≥2 WebContentsView children) and the parent
 * BrowserWindow background is dark (#171717) so no white frame flashes
 * pre-load.
 */
test('ComfyUI window has dark background and split-view architecture @lifecycle', async () => {
  const arch = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const children = win.contentView.children
      const comfyChild = children.find((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ) as { getBounds(): { x: number; y: number; width: number; height: number }; getVisible(): boolean } | undefined
      if (!comfyChild) continue
      const bounds = comfyChild.getBounds()
      return {
        childCount: children.length,
        allWebContentsViews: children.every((v) => v instanceof WebContentsView),
        bg: win.getBackgroundColor(),
        comfyBounds: bounds,
        comfyVisible: comfyChild.getVisible(),
      }
    }
    return null
  })

  expect(arch, 'ComfyUI BrowserWindow not found among open windows').not.toBeNull()
  expect(arch!.childCount).toBeGreaterThanOrEqual(2)
  expect(arch!.allWebContentsViews).toBe(true)
  expect(arch!.bg.toLowerCase()).toBe('#171717')
  // Regression guard for the chooser-pick in-place attach onto a unique-
  // partition install: rebuildComfyViewIfNeeded swaps entry.comfyView, and
  // a stale closure in layoutViews used to leave the freshly-built view
  // at default 0×0 invisible bounds — ComfyUI would load but never paint.
  expect(arch!.comfyVisible, 'comfyView is hidden').toBe(true)
  expect(arch!.comfyBounds.width, 'comfyView width is 0').toBeGreaterThan(0)
  expect(arch!.comfyBounds.height, 'comfyView height is 0').toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// Return to Dashboard — symmetric undo of in-place attach
// ---------------------------------------------------------------------------

test('return-to-dashboard flips install host in place (same window id) @lifecycle', async () => {
  // Snapshot the live BrowserWindow ids BEFORE the flip so the
  // post-flip assertion can prove the install-backed host was reused
  // as the chooser host instead of being closed and replaced.
  const before = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Trigger the same code path the File menu's "Return to Dashboard"
  // entry runs (popup item handler calls `returnToDashboard(parentEntryId)`).
  const flippedId = await returnFirstInstallHostToDashboard(ctx.app)
  expect(flippedId, 'no install-backed host window found to flip').not.toBeNull()
  expect(before.ids).toContain(flippedId)

  // After the flip the comfyView should no longer be loading a localhost URL
  // (the install was detached and the comfyView navigated to about:blank).
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(false)

  const after = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Same window count (no fresh window) and the flipped id is still alive —
  // proving the install-backed host stayed the same BrowserWindow when it
  // returned to chooser mode.
  expect(after.count).toBe(before.count)
  expect(after.ids).toContain(flippedId)

  // The chooser body should be visible again on the same window. The
  // install-backed PanelApp was destroyed at attach time, so wait for
  // the chooser PanelApp's webContents to be (re-)created by the in-place
  // detach before driving DOM assertions through it.
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)

  // Re-launch ComfyUI from the same chooser host so the subsequent stop
  // test can find a running comfy webContents to close. The host id must
  // STILL be the same one we just flipped (chooser → install in place).
  await clickInstallTile(ctx.panel, 'ComfyUI')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)

  const reattached = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return { count: wins.length, comfyHostId: comfyHost?.id ?? null }
  })
  expect(reattached.count).toBe(before.count)
  expect(reattached.comfyHostId).toBe(flippedId)
})

// ---------------------------------------------------------------------------
// Real update — exercise runComfyUIUpdate end-to-end against GitHub.
//
// The install above lands on the latest stable tag. To prove the update
// path *actually does something*, force ComfyUI's working tree backwards
// a few commits via real `git reset --hard`, then drive the in-place
// `update-comfyui` action and assert the working-tree HEAD moves forward
// again. This exercises:
//   - the bundled `update_comfyui.py` script (real Python subprocess)
//   - real `git fetch` from github.com/comfyanonymous/ComfyUI
//   - real `git checkout` of the latest stable tag
//   - filtered `uv pip install -r requirements.txt` if requirements
//     changed across the rolled-back range
// ---------------------------------------------------------------------------

interface InstallationLite {
  id: string
  installPath: string
}

interface UpdateActionResult {
  ok: boolean
  message?: string
  navigate?: string
}

let _updateInstallId = ''
let _updateInstallPath = ''
let _comfyUIDir = ''
let _rolledBackCommit = ''

test('stop ComfyUI again so update-comfyui (requires stopped) can run @lifecycle', async () => {
  // `update-comfyui` is in REQUIRES_STOPPED; the prior test re-launched.
  // Detach in place rather than closing the window so the chooser host
  // stays alive for the subsequent re-launch.
  await returnFirstInstallHostToDashboard(ctx.app)
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(false)
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)
})

test('roll ComfyUI HEAD back so the update has work to do @lifecycle', async () => {
  const installs = await ctx.panel.evaluate<InstallationLite[]>(
    `window.api.getInstallations()`,
  )
  expect(installs.length, 'no tracked installation after install').toBeGreaterThan(0)
  const inst = installs[0]!
  _updateInstallId = inst.id
  _updateInstallPath = inst.installPath
  _comfyUIDir = path.join(_updateInstallPath, 'ComfyUI')

  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(headBefore).toMatch(/^[a-f0-9]{40}$/)

  // Roll back 3 commits. Small enough to (usually) avoid a requirements
  // change crossing it — if it does, the update still runs, just slower.
  execFileSync('git', ['reset', '--hard', 'HEAD~3'], {
    cwd: _comfyUIDir, stdio: 'pipe', windowsHide: true,
  })

  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(headAfter, 'git reset --hard did not move HEAD').not.toBe(headBefore)
  _rolledBackCommit = headAfter
})

test('update-comfyui drives the real updater and moves HEAD forward @lifecycle', async () => {
  // Real update can run pip-install if requirements.txt crossed our 3-commit
  // rollback. Stretch the per-test timeout to cover that worst case.
  test.setTimeout(600_000)
  expect(_rolledBackCommit, 'rolled-back commit not captured').toBeTruthy()

  const result = await ctx.panel.evaluate<UpdateActionResult>(
    `window.api.runAction(${JSON.stringify(_updateInstallId)}, 'update-comfyui', { channel: 'stable' })`,
  )
  expect(result.ok, `update-comfyui failed: ${result.message ?? ''}`).toBe(true)

  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(headAfter, 'update did not move HEAD off the rolled-back commit').not.toBe(_rolledBackCommit)

  // The update should land on a commit reachable from origin/master that is
  // strictly newer than (or equal to) the rolled-back one — never older.
  const aheadCount = execFileSync('git', ['rev-list', '--count', `${_rolledBackCommit}..${headAfter}`], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(parseInt(aheadCount, 10), `post-update HEAD ${headAfter} is not ahead of rolled-back commit ${_rolledBackCommit}`).toBeGreaterThan(0)
})

test('re-launch ComfyUI after update validates the updated install runs @lifecycle', async () => {
  await clickInstallTile(ctx.panel, 'ComfyUI')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)
})

// ---------------------------------------------------------------------------
// FLOW 1 — IN_PLACE_RELAUNCH coverage via the real picker UI.
//
// The existing direct-runAction update test above covers the stopped-install
// code path. These tests cover the running-install path: the user opens the
// picker against a live ComfyUI, clicks Update Now (or Restore Snapshot),
// confirms in the popup's own dialog, and the panel-side apiCall wrapper
// self-stops + runs the op + relaunches in place. Each test re-uses the
// real ~500MB install the lifecycle suite already built and drives the
// actions through real DOM gestures.
// ---------------------------------------------------------------------------

interface SnapshotSummaryLite {
  filename: string
  label: string | null
}
interface SnapshotListLite { snapshots: SnapshotSummaryLite[] }

interface OpenInstallWindowPayload {
  installationId: string
}
interface RunActionInvocation {
  installationId?: string
  actionId?: string
}
interface StopComfyInvocation {
  installationId?: string
}

/** Polls until the title-popup webContents reports hidden (the picker
 *  closes itself once main routes the action), then waits for the
 *  panel-side `.brand-progress` takeover to mount. Used by every
 *  picker-driven action whose op lands in the ProgressModal. */
async function waitForProgressTakeoverAfterPopupClose(): Promise<void> {
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 10_000, intervals: [100, 200],
    })
    .toBe(false)
  await ctx.panel.waitForVisible('.brand-progress', { timeout: 30_000 })
}

/** Polls until a `run-action` IPC for `installationId` with `actionId`
 *  has been recorded. Wraps the long-budget poll the picker-driven
 *  update / restore / restart tests need to wait for the IN_PLACE_RELAUNCH
 *  launch leg. */
async function waitForRunAction(
  installationId: string, actionId: string,
  opts: { timeout?: number; intervals?: number[] } = {},
): Promise<void> {
  await expect
    .poll(async () => {
      const calls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
      return calls.some((c) => c.installationId === installationId && c.actionId === actionId)
    }, { timeout: opts.timeout ?? 540_000, intervals: opts.intervals ?? [2_000, 5_000] })
    .toBe(true)
}

async function getRunActionsFor(installationId: string): Promise<RunActionInvocation[]> {
  const calls = (await getIpcInvocations(ctx.app, 'run-action')) as RunActionInvocation[]
  return calls.filter((c) => c.installationId === installationId)
}

async function getStopsFor(installationId: string): Promise<StopComfyInvocation[]> {
  const calls = (await getIpcInvocations(ctx.app, 'stop-comfyui')) as StopComfyInvocation[]
  return calls.filter((c) => c.installationId === installationId)
}

let _restoreSnapshotFilename = ''
let _snapshotHeadAtCapture = ''

test('captures a snapshot for the picker-driven restore test @lifecycle', async () => {
  // ComfyUI is running from the prior re-launch test. `snapshot-save`
  // is NOT in REQUIRES_STOPPED so it runs against a live install — the
  // snapshot just records the current state. Captured label gives us a
  // stable filename to grab in the restore test below.
  expect(_updateInstallId, 'update install id not captured').toBeTruthy()
  await ctx.panel.evaluate<unknown>(
    `window.api.runAction(${JSON.stringify(_updateInstallId)}, 'snapshot-save', { label: 'lifecycle-restore-target' })`,
  )
  const list = await ctx.panel.evaluate<SnapshotListLite>(
    `window.api.getSnapshots(${JSON.stringify(_updateInstallId)})`,
  )
  const target = list.snapshots.find((s) => s.label === 'lifecycle-restore-target')
  expect(target, 'lifecycle-restore-target snapshot missing from getSnapshots').toBeDefined()
  _restoreSnapshotFilename = target!.filename
  _snapshotHeadAtCapture = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(_snapshotHeadAtCapture).toMatch(/^[a-f0-9]{40}$/)
})

test('picker-driven update-comfyui IN_PLACE_RELAUNCH while running @lifecycle', async () => {
  // Real `update-comfyui` against github.com can spend minutes inside
  // `uv pip install -r requirements.txt` if the rolled-back range
  // crosses a requirements change. Mirror the stopped-install
  // update test's 10-minute budget.
  test.setTimeout(600_000)

  // Roll HEAD back so the update has work — the prior update test
  // already moved HEAD forward to the latest stable, so we have to
  // un-do that for the picker click to show "Update available".
  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  execFileSync('git', ['reset', '--hard', 'HEAD~3'], {
    cwd: _comfyUIDir, stdio: 'pipe', windowsHide: true,
  })
  const rolledBack = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(rolledBack, 'git reset --hard did not move HEAD').not.toBe(headBefore)

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  // Open the picker in expanded mode on the Update tab. Channel
  // metadata loads via real `check-update` against github.com — the
  // Update Now button appears once the stable channel reports an
  // update available.
  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(_updateInstallId)},
        mode: 'expanded',
        initialTab: 'update',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitForSelector(byTestId(TID.updateActionButton('update-comfyui')), { timeout: 60_000 })
  expect(await popup.click(byTestId(TID.updateActionButton('update-comfyui')))).toBe(true)

  // The update action carries `confirm.messageDetails` (truncated
  // release notes), so it lands in `ModalDialog`'s rich-confirm
  // branch — `TID.modalConfirm` is the primary CTA there.
  await popup.waitForVisible(byTestId(TID.modalConfirm), { timeout: 15_000 })
  expect(await popup.click(byTestId(TID.modalConfirm))).toBe(true)

  // Popup hides; the panel's ProgressModal owns the long-running op.
  await waitForProgressTakeoverAfterPopupClose()

  // Wait for the relaunch leg of IN_PLACE_RELAUNCH to fire (panel-side
  // `useDeepLinkRouter` appends `runAction('launch')` after a successful
  // update). Then wait for the comfy frontend to be loaded again.
  await waitForRunAction(_updateInstallId, 'launch')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000, 2_000] }).toBe(true)

  // IPC chain: exactly one self-stop, then update-comfyui then launch
  // (both scoped to our installation id).
  const ourStops = await getStopsFor(_updateInstallId)
  expect(ourStops.length, 'self-stop should fire exactly once for IN_PLACE_RELAUNCH').toBe(1)

  const ourRunCalls = await getRunActionsFor(_updateInstallId)
  expect(ourRunCalls.length, 'update + launch run-action calls').toBeGreaterThanOrEqual(2)
  expect(ourRunCalls[0]?.actionId, 'first run-action should be update-comfyui').toBe('update-comfyui')
  const launchIdx = ourRunCalls.findIndex((c) => c.actionId === 'launch')
  expect(launchIdx, 'launch run-action should follow update-comfyui').toBeGreaterThan(0)

  // HEAD moved forward off the rolled-back commit.
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(headAfter, 'update did not move HEAD').not.toBe(rolledBack)
})

test('picker-driven snapshot-restore IN_PLACE_RELAUNCH while running @lifecycle', async () => {
  test.setTimeout(600_000)
  expect(_restoreSnapshotFilename, 'restore-target snapshot not captured').toBeTruthy()

  // Move HEAD off the snapshot commit so the restore has work to do.
  // Use a parent of the snapshot commit so restore lands somewhere
  // different from the current working tree.
  execFileSync('git', ['reset', '--hard', `${_snapshotHeadAtCapture}~5`], {
    cwd: _comfyUIDir, stdio: 'pipe', windowsHide: true,
  })
  const rolledBack = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(rolledBack, 'rollback did not change HEAD off the snapshot commit').not.toBe(_snapshotHeadAtCapture)

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(_updateInstallId)},
        mode: 'expanded',
        initialTab: 'snapshots',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  // Expand the snapshot row to reveal Restore.
  await popup.waitForSelector(byTestId(TID.snapshotRow(_restoreSnapshotFilename)), { timeout: 30_000 })
  expect(await popup.click(byTestId(TID.snapshotRow(_restoreSnapshotFilename)))).toBe(true)
  await popup.waitForVisible(byTestId(TID.snapshotRowRestore(_restoreSnapshotFilename)), { timeout: 10_000 })
  expect(await popup.click(byTestId(TID.snapshotRowRestore(_restoreSnapshotFilename)))).toBe(true)

  // SnapshotsView builds a diff-preview confirm with `messageDetails` —
  // rich confirm branch, `TID.modalConfirm` is the primary CTA.
  await popup.waitForVisible(byTestId(TID.modalConfirm), { timeout: 30_000 })
  expect(await popup.click(byTestId(TID.modalConfirm))).toBe(true)

  await waitForProgressTakeoverAfterPopupClose()

  // Wait for the IN_PLACE_RELAUNCH launch leg + frontend load.
  await waitForRunAction(_updateInstallId, 'launch')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000, 2_000] }).toBe(true)

  const ourStops = await getStopsFor(_updateInstallId)
  expect(ourStops.length, 'self-stop should fire exactly once for IN_PLACE_RELAUNCH').toBe(1)

  const ourRunCalls = await getRunActionsFor(_updateInstallId)
  expect(ourRunCalls[0]?.actionId, 'first run-action should be snapshot-restore').toBe('snapshot-restore')
  expect(ourRunCalls.some((c) => c.actionId === 'launch'), 'launch run-action must follow restore').toBe(true)

  // Snapshot restore moves ComfyUI's HEAD to the snapshot's commit.
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(headAfter, 'snapshot-restore did not land HEAD on the snapshot commit').toBe(_snapshotHeadAtCapture)
})

// ---------------------------------------------------------------------------
// Restart synthetic action — driven through the compact-picker row's
// "Restart" CTA. The CTA fires `restartInstall` over the picker bridge,
// which lives in `main/index.ts` as `restartInstallFromPicker` — confirm
// via the shell-level system modal (migrated off `dialog.showMessageBox`),
// then main runs `ipc.stopRunning` and routes a `picker-pick-install`
// payload back to the panel for the re-launch.
//
// Note: this path intentionally bypasses the `stop-comfyui` IPC channel
// (it goes through `ipc.stopRunning` directly), so the per-channel
// invocation count for `stop-comfyui` stays at zero.
// ---------------------------------------------------------------------------

test('picker compact-row Restart drives system-modal confirm + re-launch @lifecycle', async () => {
  test.setTimeout(300_000)

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  await ctx.panel.evaluate<boolean>(`(() => { window.api.openInstancePicker(); return true })()`)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  // PickerRow renders its primary CTA as "Restart" when the install is
  // currently running — same test id either way.
  await popup.waitForSelector(byTestId(TID.pickerRowOpen(_updateInstallId)), { timeout: 15_000 })
  expect(await popup.click(byTestId(TID.pickerRowOpen(_updateInstallId)))).toBe(true)

  // Popup hides as soon as main routes the restart-install IPC; the
  // system-modal overlay mounts on the host window in its place.
  await expect
    .poll(() => isPopupVisible(ctx.app, 'comfyTitlePopup.html'), {
      timeout: 10_000, intervals: [100, 200],
    })
    .toBe(false)
  await waitForWebContents(ctx.app, 'comfySystemModal.html')
  const sysModal = systemModalPage(ctx.app)
  await sysModal.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 15_000 })
  expect(await sysModal.click(byTestId(TID.baseAlertAction))).toBe(true)

  // The restart path tears down + re-launches comfy in place. Wait
  // for the launch leg to fire on the panel side (panel handles the
  // `picker-pick-install` overlay → `performPickerLaunch` →
  // `runAction(id, 'launch')`), then for the frontend to be live.
  await waitForRunAction(_updateInstallId, 'launch', { timeout: 180_000, intervals: [1_000, 2_000] })
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)

  // The picker compact Restart deliberately bypasses the `stop-comfyui`
  // renderer IPC (main uses `ipc.stopRunning` directly), so no
  // invocations should land on that channel.
  const stopCalls = await getStopsFor(_updateInstallId)
  expect(stopCalls.length, 'compact picker Restart should bypass the stop-comfyui renderer IPC').toBe(0)

  const launchCalls = (await getRunActionsFor(_updateInstallId))
    .filter((c) => c.actionId === 'launch')
  expect(launchCalls.length, 'exactly one launch run-action for the restart').toBeGreaterThanOrEqual(1)
})

// ---------------------------------------------------------------------------
// Synthetic `restart` id (stop → wait → launch) — driven through the
// picker's pin-bottom Launch→Restart swap that fires when the install
// is running. This is the `useComfyUISettings.runAction` path, distinct
// from the picker compact-row Restart above which routes through main's
// `restartInstallFromPicker` and bypasses the renderer `stop-comfyui`
// IPC. The synthetic id wraps `stopAndWaitForExit → runAction('launch')`
// behind a single "Restarting ComfyUI" progress title so the user sees
// one continuous op instead of stop→idle→launch flashes.
// ---------------------------------------------------------------------------

test('picker pin-bottom Restart drives stop+launch under one "Restarting ComfyUI" progress title @lifecycle', async () => {
  test.setTimeout(300_000)

  // Sanity: prior compact-row Restart test left ComfyUI running.
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(true)
  const beforeSnapshot = await getRunningSessionSnapshot(ctx.app, _updateInstallId)
  expect(beforeSnapshot, 'expected a running session before pin-bottom Restart').not.toBeNull()

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  // Open the picker in expanded mode on the Settings/Config tab so the
  // pin-bottom MoreMenu is visible. `initialTab: 'config'` matches the
  // pin-bottom Copy test above.
  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(_updateInstallId)},
        mode: 'expanded',
        initialTab: 'config',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  // Open the footer "More" overflow menu → the swap surfaces the
  // primary Launch item as `pin-bottom-action-restart` because the
  // install is currently running.
  await popup.waitForVisible('[data-more-trigger]', { timeout: 15_000 })
  expect(await popup.click('[data-more-trigger]')).toBe(true)
  await popup.waitForVisible(byTestId(TID.pinBottomAction('restart')), { timeout: 10_000 })
  // Cross-check: the bare `launch` item must NOT be present when the
  // install is running — the swap to `restart` is what we're testing.
  const launchVisible = await popup.exists(byTestId(TID.pinBottomAction('launch')))
  expect(launchVisible, 'pin-bottom Launch must NOT render while running (Restart swap)').toBe(false)
  expect(await popup.click(byTestId(TID.pinBottomAction('restart')))).toBe(true)

  // Restart confirm renders in the popup's own ModalDialog → BaseAlert
  // simple confirm (title + message + confirmLabel only).
  await popup.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 10_000 })
  expect(await popup.click(byTestId(TID.baseAlertAction))).toBe(true)

  // ProgressModal mounts on the panel host with the single continuous
  // "Restarting ComfyUI" title from `actions.restartProgressTitle`.
  await waitForProgressTakeoverAfterPopupClose()
  await expect
    .poll(async () => {
      const title = await ctx.panel.textOf('.brand-progress')
      return title?.includes('Restarting ComfyUI') ?? false
    }, { timeout: 10_000, intervals: [200, 500] })
    .toBe(true)

  // Wait for the launch leg + the new session to register, then for
  // the comfy frontend to come back up.
  await waitForRunAction(_updateInstallId, 'launch', { timeout: 180_000, intervals: [1_000, 2_000] })
  await expect
    .poll(async () => {
      const after = await getRunningSessionSnapshot(ctx.app, _updateInstallId)
      if (!after) return false
      return after.startedAt > (beforeSnapshot?.startedAt ?? 0)
    }, { timeout: 180_000, intervals: [1_000, 2_000] })
    .toBe(true)
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000] }).toBe(true)

  // The pin-bottom Restart MUST fire the renderer-side `stop-comfyui`
  // IPC (via `stopAndWaitForExit`) — the audit's key distinction from
  // the compact-row Restart path tested above.
  const stopCalls = await getStopsFor(_updateInstallId)
  expect(stopCalls.length, 'pin-bottom Restart must fire stop-comfyui via stopAndWaitForExit').toBeGreaterThanOrEqual(1)

  const launchCalls = (await getRunActionsFor(_updateInstallId))
    .filter((c) => c.actionId === 'launch')
  expect(launchCalls.length, 'exactly one launch run-action for the synthetic restart').toBeGreaterThanOrEqual(1)

  // No bare `restart` action ever reaches main — the synthetic id is
  // renderer-only. Main only ever sees `launch` for the restart leg.
  const restartCalls = (await getRunActionsFor(_updateInstallId))
    .filter((c) => c.actionId === 'restart')
  expect(restartCalls.length, 'synthetic restart id must not leak to main as a run-action').toBe(0)
})

// ---------------------------------------------------------------------------
// FLOW 2 — real copy via the picker's pin-bottom MoreMenu.
//
// `copy` is REQUIRES_STOPPED + a runAction prompt chain. The picker's
// footer "More" menu → Copy item exercises the full prompt →
// showProgress → real ~500MB filesystem copy path. (The dashboard
// kebab → Copy Installation path is covered separately further down.)
// ---------------------------------------------------------------------------

let _copyInstallId = ''
let _copyInstallPath = ''

test('picker pin-bottom Copy creates a real ~500MB copy of the install @lifecycle', async () => {
  test.setTimeout(600_000)

  // Copy is REQUIRES_STOPPED — stop comfy via return-to-dashboard so
  // the IPC handler doesn't bail and the picker dispatches without a
  // self-stop preamble.
  await returnFirstInstallHostToDashboard(ctx.app)
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(false)
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)

  // Snapshot BrowserWindow ids before the copy fires. The copy emits
  // `open-install-window` for the NEW install, which (because no window
  // backs it yet) spawns a fresh chooser host. Subsequent tests use
  // URL-marker-based helpers (`panel.html`) which would non-deterministically
  // bind to either chooser host, so we close the extra below.
  const windowIdsBeforeCopy = await ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.id),
  )

  await resetIpcInvocations(ctx.app, 'open-install-window')
  await resetIpcInvocations(ctx.app, 'run-action')

  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(_updateInstallId)},
        mode: 'expanded',
        initialTab: 'config',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  // Open the footer "More" overflow menu → click Copy.
  await popup.waitForVisible('[data-more-trigger]', { timeout: 15_000 })
  expect(await popup.click('[data-more-trigger]')).toBe(true)
  await popup.waitForVisible(byTestId(TID.pinBottomAction('copy')), { timeout: 10_000 })
  expect(await popup.click(byTestId(TID.pinBottomAction('copy')))).toBe(true)

  // Prompt for the copy's new name (rendered by ModalDialog's prompt
  // branch inside the popup webContents).
  await popup.waitForVisible(byTestId(TID.modalPromptInput), { timeout: 10_000 })
  const newName = 'ComfyUI Copy E2E'
  await popup.evaluate<void>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(byTestId(TID.modalPromptInput))})
      if (!el) throw new Error('prompt input not found')
      el.value = ${JSON.stringify(newName)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`,
  )
  expect(await popup.click(byTestId(TID.modalConfirm))).toBe(true)

  await waitForProgressTakeoverAfterPopupClose()

  // Wait for the copy to complete + `open-install-window` to fire for
  // the new install. Real ~500MB filesystem copy → generous timeout.
  await expect
    .poll(async () => {
      const calls = (await getIpcInvocations(ctx.app, 'open-install-window')) as OpenInstallWindowPayload[]
      return calls.find((c) => c.installationId && c.installationId !== _updateInstallId) ?? null
    }, { timeout: 540_000, intervals: [2_000, 5_000] })
    .not.toBeNull()

  const openCalls = (await getIpcInvocations(ctx.app, 'open-install-window')) as OpenInstallWindowPayload[]
  const newCall = openCalls.find((c) => c.installationId && c.installationId !== _updateInstallId)
  expect(newCall?.installationId, 'open-install-window did not capture a NEW installationId').toBeTruthy()
  _copyInstallId = newCall!.installationId

  const installs = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  const copyRecord = installs.find((i) => i.id === _copyInstallId)
  expect(copyRecord, 'copy installation not found in getInstallations').toBeDefined()
  _copyInstallPath = copyRecord!.installPath

  // Disk shape: copy is a full standalone tree (ComfyUI/.git +
  // standalone-env + marker), and the source dir is untouched.
  expect(existsSync(path.join(_copyInstallPath, 'ComfyUI', '.git')), 'copy missing ComfyUI/.git').toBe(true)
  expect(existsSync(path.join(_copyInstallPath, 'standalone-env')), 'copy missing standalone-env/').toBe(true)
  expect(existsSync(path.join(_copyInstallPath, '.comfyui-desktop-2')), 'copy missing .comfyui-desktop-2 marker').toBe(true)
  expect(existsSync(path.join(_updateInstallPath, 'ComfyUI', '.git')), 'source ComfyUI/.git missing after copy').toBe(true)
  expect(existsSync(path.join(_updateInstallPath, '.comfyui-desktop-2')), 'source marker missing after copy').toBe(true)

  // Close the extra chooser host spawned by `open-install-window` so
  // panel.html-marker helpers in subsequent tests have a single, stable
  // target.
  const extraWindowIds = await ctx.app.evaluate(
    ({ BrowserWindow }, before) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && !before.includes(w.id))
        .map((w) => w.id),
    windowIdsBeforeCopy,
  )
  expect(
    extraWindowIds.length,
    'open-install-window should have spawned a new chooser host',
  ).toBeGreaterThan(0)
  await ctx.app.evaluate(({ BrowserWindow }, ids) => {
    for (const id of ids) {
      const w = BrowserWindow.fromId(id)
      if (w && !w.isDestroyed()) w.close()
    }
  }, extraWindowIds)
  await expect
    .poll(
      () =>
        ctx.app.evaluate(
          ({ BrowserWindow }, ids) =>
            BrowserWindow.getAllWindows().filter(
              (w) => !w.isDestroyed() && ids.includes(w.id),
            ).length,
          extraWindowIds,
        ),
      { timeout: 10_000, intervals: [100, 250] },
    )
    .toBe(0)
})

test('cleans up the copy install before the original delete test runs @lifecycle', async () => {
  test.setTimeout(300_000)
  expect(_copyInstallId, 'no copy install id captured to clean up').toBeTruthy()

  // Direct runAction('delete') bypasses the confirm chain — the copy
  // is stopped (never launched), so no `stop-comfyui` preamble is
  // needed. Frees disk before the existing final delete test runs
  // against the original.
  const result = await ctx.panel.evaluate<UpdateActionResult>(
    `window.api.runAction(${JSON.stringify(_copyInstallId)}, 'delete')`,
  )
  expect(result.ok, `delete copy failed: ${result.message ?? ''}`).toBe(true)

  expect(existsSync(_copyInstallPath), `copy install dir ${_copyInstallPath} still on disk after delete`).toBe(false)
  const remaining = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  expect(remaining.find((i) => i.id === _copyInstallId), 'copy install record not removed after delete').toBeUndefined()
  expect(remaining.find((i) => i.id === _updateInstallId), 'original install was unexpectedly removed').toBeDefined()
})

// ---------------------------------------------------------------------------
// Dashboard kebab "Copy Installation" / "Untrack" — both route through
// `opts.onManage(inst, { autoAction })` so the picker opens in
// expanded mode with the autoAction seed and `ComfyUISettingsContent`
// fires the action through the full `useComfyUISettings.runAction`
// chain (prompt → disk-check → showProgress for copy; confirm → inline
// runAction for remove).
//
// One fresh ~500MB kebab-driven copy is the target for both tests
// (kebab Copy on the original → kebab Untrack on the new copy) so the
// registry-only Untrack semantics can be validated without breaking
// the original-install state the final Delete test depends on. The
// kebab-copy's on-disk tree is then `fs.rm`'d manually to reclaim the
// ~500MB before the final Delete test runs.
// ---------------------------------------------------------------------------

let _kebabCopyInstallId = ''
let _kebabCopyInstallPath = ''

test('dashboard kebab "Copy Installation" creates a real ~500MB copy @lifecycle', async () => {
  test.setTimeout(600_000)

  // The prior cleanup test ran direct `runAction('delete')` against
  // the previous picker-copy and ComfyUI is stopped from earlier; the
  // chooser is already visible. Sanity-check the kebab is available
  // on the seeded tile before driving the menu.
  await expectChooserVisible(ctx.panel)
  await ctx.panel.waitForVisible(byTestId(TID.dashboardTileKebab(_updateInstallId)), { timeout: 10_000 })

  // Snapshot BrowserWindow ids so the post-copy chooser-host spawned
  // by `open-install-window` can be closed deterministically (same
  // bookkeeping the picker pin-bottom Copy test above uses).
  const windowIdsBeforeCopy = await ctx.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => w.id),
  )

  await resetIpcInvocations(ctx.app, 'open-install-window')
  await resetIpcInvocations(ctx.app, 'run-action')

  // Open the dashboard kebab on the original install tile and click
  // the Copy Installation item — the composable routes this to
  // `opts.onManage(inst, { autoAction: 'copy' })` which expands the
  // picker on the Config tab with the autoAction seed.
  expect(await ctx.panel.click(byTestId(TID.dashboardTileKebab(_updateInstallId)))).toBe(true)
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem('copy-install')), { timeout: 5_000 })
  expect(await ctx.panel.click(byTestId(TID.contextMenuItem('copy-install')))).toBe(true)

  // Picker mounts in expanded mode with autoAction='copy' →
  // ComfyUISettingsContent fires `runAction('copy')` → renderer-side
  // prompt for the new install name.
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitForVisible(byTestId(TID.modalPromptInput), { timeout: 15_000 })

  const newName = 'ComfyUI Kebab Copy E2E'
  await popup.evaluate<void>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(byTestId(TID.modalPromptInput))})
      if (!el) throw new Error('prompt input not found')
      el.value = ${JSON.stringify(newName)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`,
  )
  expect(await popup.click(byTestId(TID.modalConfirm))).toBe(true)

  // Picker hides; the panel's ProgressModal owns the copy op.
  await waitForProgressTakeoverAfterPopupClose()

  // Wait for the copy to complete + `open-install-window` for the new
  // install id. Real ~500MB filesystem copy → generous timeout.
  await expect
    .poll(async () => {
      const calls = (await getIpcInvocations(ctx.app, 'open-install-window')) as OpenInstallWindowPayload[]
      return calls.find((c) => c.installationId && c.installationId !== _updateInstallId) ?? null
    }, { timeout: 540_000, intervals: [2_000, 5_000] })
    .not.toBeNull()

  const openCalls = (await getIpcInvocations(ctx.app, 'open-install-window')) as OpenInstallWindowPayload[]
  const newCall = openCalls.find((c) => c.installationId && c.installationId !== _updateInstallId)
  expect(newCall?.installationId, 'open-install-window did not capture a NEW installationId').toBeTruthy()
  _kebabCopyInstallId = newCall!.installationId

  const installs = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  const copyRecord = installs.find((i) => i.id === _kebabCopyInstallId)
  expect(copyRecord, 'kebab-copy installation not found in getInstallations').toBeDefined()
  _kebabCopyInstallPath = copyRecord!.installPath

  // Disk shape: kebab copy materializes the same standalone tree the
  // picker pin-bottom Copy did, and the source tree is unchanged.
  expect(existsSync(path.join(_kebabCopyInstallPath, 'ComfyUI', '.git')), 'kebab copy missing ComfyUI/.git').toBe(true)
  expect(existsSync(path.join(_kebabCopyInstallPath, 'standalone-env')), 'kebab copy missing standalone-env/').toBe(true)
  expect(existsSync(path.join(_kebabCopyInstallPath, '.comfyui-desktop-2')), 'kebab copy missing .comfyui-desktop-2 marker').toBe(true)
  expect(existsSync(path.join(_updateInstallPath, 'ComfyUI', '.git')), 'source ComfyUI/.git missing after kebab copy').toBe(true)
  expect(existsSync(path.join(_updateInstallPath, '.comfyui-desktop-2')), 'source marker missing after kebab copy').toBe(true)

  // Critical assertion for the regression: the kebab dispatch must
  // NOT have fired a `runAction('copy')` IPC directly from the
  // dashboard — it has to go through the picker autoAction route so
  // the prompt is collected. Direct dispatch would carry no
  // `actionData` and main would return `{ ok: false }` silently.
  const runActions = await getRunActionsFor(_updateInstallId)
  const copyDispatches = runActions.filter((c) => c.actionId === 'copy')
  expect(copyDispatches.length, 'kebab dispatch must route copy through the picker, not call runAction directly').toBeLessThanOrEqual(1)

  // Close the extra chooser host(s) spawned by `open-install-window`
  // so the panel.html-marker helpers in subsequent tests have a single
  // stable target.
  const extraWindowIds = await ctx.app.evaluate(
    ({ BrowserWindow }, before) =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && !before.includes(w.id))
        .map((w) => w.id),
    windowIdsBeforeCopy,
  )
  await ctx.app.evaluate(({ BrowserWindow }, ids) => {
    for (const id of ids) {
      const w = BrowserWindow.fromId(id)
      if (w && !w.isDestroyed()) w.close()
    }
  }, extraWindowIds)
  await expect
    .poll(
      () =>
        ctx.app.evaluate(
          ({ BrowserWindow }, ids) =>
            BrowserWindow.getAllWindows().filter(
              (w) => !w.isDestroyed() && ids.includes(w.id),
            ).length,
          extraWindowIds,
        ),
      { timeout: 10_000, intervals: [100, 250] },
    )
    .toBe(0)
})

test('dashboard kebab "Untrack" removes the install from the registry without touching disk @lifecycle', async () => {
  test.setTimeout(60_000)
  expect(_kebabCopyInstallId, 'no kebab-copy install id to untrack').toBeTruthy()
  expect(_kebabCopyInstallPath, 'no kebab-copy install path captured').toBeTruthy()

  // Dashboard should be visible again on the panel and show BOTH the
  // original tile and the kebab-copy tile.
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)
  await ctx.panel.waitForVisible(byTestId(TID.dashboardTileKebab(_kebabCopyInstallId)), { timeout: 10_000 })

  // Click the kebab on the kebab-copy tile (NOT the original — the
  // original needs to survive for the final Delete test). The Untrack
  // item routes through `opts.onManage(inst, { autoAction: 'remove' })`
  // → picker opens expanded with the autoAction seed → confirm modal.
  expect(await ctx.panel.click(byTestId(TID.dashboardTileKebab(_kebabCopyInstallId)))).toBe(true)
  await ctx.panel.waitForVisible(byTestId(TID.contextMenuItem('untrack')), { timeout: 5_000 })
  expect(await ctx.panel.click(byTestId(TID.contextMenuItem('untrack')))).toBe(true)

  // Picker opens in expanded mode; ComfyUISettingsContent fires
  // runAction('remove') which renders the source action's confirm
  // dialog. `remove` carries no `showProgress` and is plain text, so
  // the simple-confirm renders as a BaseAlert (TID.baseAlertAction)
  // inside the popup webContents.
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)
  await popup.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 15_000 })
  expect(await popup.click(byTestId(TID.baseAlertAction))).toBe(true)

  // Untrack returns `{ navigate: 'list' }` → the picker collapses to
  // compact and main scrubs the row. Poll the registry until the
  // kebab-copy id is gone.
  await expect
    .poll(
      async () => {
        const installs = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
        return installs.some((i) => i.id === _kebabCopyInstallId)
      },
      { timeout: 30_000, intervals: [250, 500] },
    )
    .toBe(false)

  // Critical Untrack semantics: registry entry gone, disk preserved.
  // (Delete is the destructive counterpart — this is the difference.)
  expect(existsSync(_kebabCopyInstallPath), 'untrack must NOT touch disk; kebab-copy dir should still exist').toBe(true)
  expect(
    existsSync(path.join(_kebabCopyInstallPath, '.comfyui-desktop-2')),
    'untrack must leave marker file intact on disk',
  ).toBe(true)

  // Original install untouched.
  const remaining = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  expect(remaining.find((i) => i.id === _updateInstallId), 'untrack must not affect the original install').toBeDefined()
})

test('cleans up the untracked kebab-copy on disk before the final Delete test runs @lifecycle', async () => {
  test.setTimeout(120_000)
  expect(_kebabCopyInstallPath, 'no kebab-copy install path to clean up').toBeTruthy()
  expect(existsSync(_kebabCopyInstallPath), 'kebab-copy dir already gone — Untrack test invariant violated').toBe(true)

  // Untrack intentionally leaves the ~500MB tree on disk; the test
  // suite has to free it before the final fully-installed Delete test
  // runs so the harness home temp dir doesn't carry a stale copy.
  // Same `fs.rm` semantics the main-side delete handler uses; run from
  // the test process directly (the path lives on the harness home temp
  // dir and is readable by both processes).
  rmSync(_kebabCopyInstallPath, { recursive: true, force: true })

  await expect
    .poll(() => existsSync(_kebabCopyInstallPath), { timeout: 60_000, intervals: [500, 1_000] })
    .toBe(false)
})

// ---------------------------------------------------------------------------
// Stop + Delete — real fs cleanup of a fully-installed standalone tree
// (~500MB on disk: ComfyUI/.git + standalone-env/ + ComfyUI/.venv).
//
// Validates the delete handler's marker-file safety check + recursive
// `fs.rm` against an install that actually has the contents users care
// about losing — including the Windows .venv where in-use file locks can
// make recursive deletion fight back.
//
// Note on the missing "close-window stops comfy" test: that path is now
// covered implicitly by the return-to-dashboard stop test above (same
// `detachInstall` teardown). We drop the explicit `win.close()` variant
// here because it always quits the app (closes the only host window),
// which would prevent the delete IPC below from running.
// ---------------------------------------------------------------------------

let _deleteInstallId = ''
let _deleteInstallPath = ''

test('stops comfy and captures the installed dir state before driving delete @lifecycle', async () => {
  // delete is in REQUIRES_STOPPED — stop comfy via return-to-dashboard so
  // the IPC handler doesn't bail on us. rtd preserves the chooser host so
  // we still have an IPC target for delete + getInstallations.
  await returnFirstInstallHostToDashboard(ctx.app)
  await expect.poll(comfyFrontendIsLoaded, { timeout: 30_000, intervals: [500] }).toBe(false)
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)

  const installs = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  expect(installs.length, 'no tracked installation after install').toBeGreaterThan(0)
  const inst = installs[0]!
  _deleteInstallId = inst.id
  _deleteInstallPath = inst.installPath

  // Sanity: this should be a fully-installed standalone tree, not the
  // empty placeholder dirs the lifecycle-delete-untrack test uses. The
  // install dir is on the same filesystem the test runs on (the harness
  // home temp dir), so we can stat it directly from the test process.
  expect(existsSync(path.join(_deleteInstallPath, 'ComfyUI', '.git')), 'installed dir missing ComfyUI/.git').toBe(true)
  expect(existsSync(path.join(_deleteInstallPath, 'standalone-env')), 'installed dir missing standalone-env/').toBe(true)
  expect(existsSync(path.join(_deleteInstallPath, '.comfyui-desktop-2')), 'installed dir missing .comfyui-desktop-2 marker').toBe(true)
})

test('real delete wipes the fully-installed ~500MB tree off disk @lifecycle', async () => {
  // Recursive delete of a full standalone install can take a while on
  // Windows when files are large (the .venv ships thousands of small
  // files plus a few hundred-MB torch wheels). Stretch the timeout.
  test.setTimeout(300_000)
  expect(_deleteInstallPath, 'install path not captured').toBeTruthy()

  const result = await ctx.panel.evaluate<UpdateActionResult>(
    `window.api.runAction(${JSON.stringify(_deleteInstallId)}, 'delete')`,
  )
  expect(result.ok, `runAction('delete') failed: ${result.message ?? ''}`).toBe(true)

  // Disk verification — the entire install tree must be gone, not just
  // a few top-level entries. Probes both the root + a deep file the
  // standalone install always materializes (ComfyUI/main.py).
  expect(existsSync(_deleteInstallPath), `install dir ${_deleteInstallPath} still exists after delete`).toBe(false)
  expect(existsSync(path.join(_deleteInstallPath, 'ComfyUI', 'main.py')), 'ComfyUI/main.py still on disk after delete').toBe(false)

  // The installation record must also be gone.
  const remaining = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  expect(remaining.find((i) => i.id === _deleteInstallId), 'install record not removed after delete').toBeUndefined()
})
