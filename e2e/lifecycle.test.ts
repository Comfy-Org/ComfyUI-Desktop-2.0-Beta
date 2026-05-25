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
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import {
  clickInstallTile,
  expectChooserVisible,
  expectTakeoverOpen,
} from './support/chooserHelpers'
import { returnFirstInstallHostToDashboard } from './support/devHooks'
import { waitForWebContents } from './support/cdpPages'

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
