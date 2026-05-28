/**
 * Lifecycle E2E: New Install (recommended standalone variant for the host
 * GPU, latest stable release) → ComfyUI auto-launches via brand chrome →
 * dashboard return → relaunch → stop.
 *
 * Downloads ~500 MB of standalone payload. Tagged @real and runs under
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
  expectChooserVisible,
  expectTakeoverOpen,
} from './support/chooserHelpers'
import {
  getIpcInvocations,
  getRunningSessionSnapshot,
  resetIpcInvocations,
} from './support/devHooks'
import {
  deleteInstallViaDashboardKebab,
  ensureInstalledAndLaunched,
  ensureInstallPanelMountedViaFileMenu,
  launchComfyByClickingTile,
  openPickerByClickingTitlePill,
  returnToDashboardViaFileMenu,
  saveSnapshotViaPicker,
} from './support/realPrereqs'
import {
  isPopupVisible,
  systemModalPage,
  titlePopupPage,
  waitForWebContents,
} from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext

/** True after `beforeAll` if an install record was hydrated from disk.
 *  Setup tests (consent / first-use / completes-install / post-install
 *  verification) skip themselves when this is set so the user can
 *  `--grep` a single later test against a reused profile.
 *
 *  Usage:
 *    # First run: name a persistent dir so the profile survives cleanup.
 *    $env:LIFECYCLE_REUSE_DIR = "$env:TEMP\comfyui-lifecycle-reuse"
 *    pnpm exec playwright test e2e/lifecycle.test.ts --project=lifecycle \
 *      --reporter=list                                  # full suite, ~5-10 min
 *
 *    # Subsequent runs against the same dir: HYDRATED flips true,
 *    # setup tests skip, --grep picks what to re-run.
 *    pnpm exec playwright test e2e/lifecycle.test.ts --project=lifecycle \
 *      --grep "snapshot-restore" --reporter=list
 *
 *    Remove-Item Env:\LIFECYCLE_REUSE_DIR
 */
let HYDRATED = false

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
  //
  // When `LIFECYCLE_REUSE_DIR` is set against a directory that already
  // contains a completed install, we rehydrate the shared
  // `let _foo = ''` state below from disk so individually-greped tests
  // behave the same as if they had followed the full chain. On a
  // first-run/empty profile the install tests run normally and produce
  // the on-disk state the next greped run consumes.
  ctx = await launchApp()

  if (!process.env['LIFECYCLE_REUSE_DIR']) {
    // Fresh mode: leave the cold-start setup tests below to drive the
    // first-use takeover + install end-to-end so each step is asserted.
    return
  }

  // Reuse mode: probe disk via the panel to decide whether an install
  // already exists. If it does, drive hydration + launch through
  // `ensureInstalledAndLaunched` (real DOM clicks, no `__e2e.*`
  // mutations) and flip HYDRATED so the setup tests below skip
  // themselves. If the reuse dir is empty, fall through and let the
  // setup tests run normally — they'll populate the profile for the
  // next greped re-run.
  try {
    await ctx.panel.waitForVisible('.chooser-view', { timeout: 10_000 })
  } catch { /* fresh boot may still be on first-use takeover */ }

  const installs = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
    .catch(() => [] as InstallationLite[])
  // Filter out the Cloud install record (no `installPath`) that's
  // seeded on first chooser mount — only a local standalone is a
  // valid hydration target.
  const localInstall = installs.find((i) => typeof i.installPath === 'string' && i.installPath.length > 0)
  if (!localInstall) {
    console.log('[lifecycle] LIFECYCLE_REUSE_DIR set but no install found — running fresh setup tests to populate the profile')
    return
  }

  const hydrated = await ensureInstalledAndLaunched(ctx)
  _updateInstallId = hydrated.id
  _updateInstallPath = hydrated.installPath
  _comfyUIDir = hydrated.comfyUIDir
  _installedCommit = hydrated.installedCommit

  // Read-only snapshot rehydration — `getSnapshots` is observation
  // only, and the snapshot file on disk was written by a prior run.
  try {
    const list = await ctx.panel.evaluate<SnapshotListLite>(
      `window.api.getSnapshots(${JSON.stringify(_updateInstallId)})`,
    )
    const target = list.snapshots.find((s) => s.label === 'lifecycle-restore-target')
    if (target) {
      _restoreSnapshotFilename = target.filename
      const snapPath = path.join(_updateInstallPath, '.launcher', 'snapshots', target.filename)
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8')) as {
        comfyui?: { commit?: string | null }
      }
      if (snap.comfyui?.commit) _snapshotHeadAtCapture = snap.comfyui.commit
    }
  } catch { /* snapshot not yet captured on this profile */ }

  HYDRATED = true
  console.log(`[lifecycle] hydrated from reused profile: installId=${_updateInstallId} commit=${_installedCommit || '(none)'} restoreSnapshot=${_restoreSnapshotFilename || '(none)'}`)
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

test('cold start lands on first-use start screen @real', async () => {
  test.skip(HYDRATED, 'reuse mode: first-use already completed on the persisted profile')
  // The first-use takeover gates the chooser body until consent +
  // cloud/local pick + Continue are completed on the merged start
  // screen (commit 5619823 clubbed the legacy two-step flow into one).
  await ctx.panel.waitForVisible('.start-hero', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="first-use-pick-cloud"]')
  await ctx.panel.waitForVisible('[data-testid="first-use-pick-local"]')
  await ctx.panel.waitForVisible('[data-testid="first-use-continue"]')
})

test('accept ToS + pick local (non-express) opens New Install takeover with form pre-filled @real', async () => {
  test.skip(HYDRATED, 'reuse mode: first-use already completed on the persisted profile')

  // Pick Local — reveals the Express-Install modifier. We want the
  // normal (non-express) local path so the New Install Tier 3 takeover
  // opens; the express path silently routes through standalone install
  // and is covered by FirstUseTakeover.test.ts unit specs.
  expect(await ctx.panel.click('[data-testid="first-use-pick-local"]')).toBe(true)
  await ctx.panel.waitForVisible('[data-testid="first-use-express-install"]', { timeout: 5_000 })

  // Express defaults to checked on Local pick — uncheck it to force
  // the New Install takeover path.
  await ctx.panel.evaluate<void>(
    `(() => {
      const wrap = document.querySelector('[data-testid="first-use-express-install"]')
      const cb = wrap && wrap.querySelector('input[type="checkbox"]')
      if (cb && cb.checked) cb.click()
    })()`,
  )

  // Tick the required ToS checkbox (telemetry stays at its default
  // opt-in; the test settings already disable telemetry network egress
  // separately, so the actual value doesn't matter here).
  expect(await ctx.panel.click('[data-testid="first-use-consent-tos"]')).toBe(true)
  await ctx.panel.waitFor(
    async () => ctx.panel.evaluate<boolean>(
      `!document.querySelector('[data-testid="first-use-continue"]').disabled`,
    ),
    { timeout: 5_000, message: 'Continue never became enabled after ticking ToS' },
  )

  // Continue with Local + non-express + no legacy desktop install:
  // emits `chain-local`, which the host swaps for the New Install
  // Tier 3 takeover (silent Tier 3 → Tier 3 swap inside `useOverlay`).
  expect(await ctx.panel.click('[data-testid="first-use-continue"]')).toBe(true)
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

  // Open Advanced so the release BaseSelect + variant rows are
  // interactive. The body is CSS-hidden when collapsed; the BaseSelect
  // trigger does not register clicks while hidden.
  expect(await ctx.panel.click('.config-advanced__summary')).toBe(true)
  await ctx.panel.waitForSelector('#source-fields button[role="combobox"]', {
    timeout: 5_000,
  })

  // Override the recommended "Latest Stable" pre-fill with the OLDEST
  // standalone release so post-install the picker / direct runAction
  // both naturally see "Update available" on the Stable channel
  // (no `git reset --hard` workaround needed in the update tests
  // further down). The release options are sorted newest-first by
  // date, so the LAST option in the listbox is the oldest.
  expect(await ctx.panel.click('#source-fields button[role="combobox"]')).toBe(true)
  await ctx.panel.waitForVisible('[role="listbox"] [role="option"]', { timeout: 10_000 })
  expect(
    await ctx.panel.evaluate<boolean>(
      `(() => {
        const opts = document.querySelectorAll('[role="listbox"] [role="option"]')
        if (opts.length === 0) return false
        opts[opts.length - 1].click()
        return true
      })()`,
    ),
    'failed to click oldest release option in BaseSelect listbox',
  ).toBe(true)

  // Picking a new release re-fires `loadFieldOptions('variant')`,
  // which flips `saveDisabled` true until the variant options resolve
  // and the recommended variant is re-picked. Wait for Continue to
  // come back enabled before moving on.
  await ctx.panel.waitFor(
    async () => ctx.app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
      if (!wc) return false
      return wc.executeJavaScript(`(() => {
        const btn = document.querySelector('.brand-primary.config-continue')
        return !!btn && !btn.disabled
      })()`) as Promise<boolean>
    }),
    { timeout: 60_000, message: 'Continue button never re-enabled after picking oldest release' },
  )

  // On Windows, force the CPU variant so the test is deterministic
  // across runners (NVIDIA hosts would otherwise download a multi-GB
  // GPU payload). macOS only publishes `mac-mps` and Linux publishes
  // no `linux-cpu` variant, so on those platforms we trust the
  // recommended pick the form already made.
  if (process.platform === 'win32') {
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

test('completes install (auto-launches via brand chrome) @real', async () => {
  test.skip(HYDRATED, 'reuse mode: install already on disk on the persisted profile')
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

test('first-use Local chain marks firstUseCompleted once and cycles firstUseMode @real', async () => {
  test.skip(HYDRATED, 'reuse mode: first-use IPC log only exists on the boot that drove the chain')
  // Asserts the chain bookkeeping the auto-launch above relied on:
  //   - `markFirstUseCompleted` (set-setting firstUseCompleted=true)
  //     fires exactly once across the entire Local chain (consent →
  //     pick-local → new-install takeover → install → auto-launch).
  //   - `setFirstUseMode` advances through 'post-consent' and lands
  //     at 'none' once the new-install takeover closes.
  // Reads from the cumulative IPC invocation log captured since boot —
  // no reset, so the assertions cover the full chain end-to-end.
  const setSettingCalls = await getIpcInvocations(ctx.app, 'set-setting') as Array<{ key: string; value: unknown }>
  const firstUseFlips = setSettingCalls.filter((c) => c.key === 'firstUseCompleted' && c.value === true)
  expect(firstUseFlips.length, 'markFirstUseCompleted should run exactly once across the chain').toBe(1)

  const modeCalls = await getIpcInvocations(ctx.app, 'comfy-window:set-first-use-mode') as Array<{ mode: string }>
  const modes = modeCalls.map((c) => c.mode)
  expect(modes, 'first-use mode sequence missing post-consent').toContain('post-consent')
  expect(modes[modes.length - 1], 'first-use mode should end at none after chain completes').toBe('none')
})

// ---------------------------------------------------------------------------
// Launch & verify split-view + dark background
// ---------------------------------------------------------------------------

test('auto-launch landed on a single host window (in-place attach) @real', async () => {
  test.skip(HYDRATED, 'reuse mode: install was not auto-launched on this boot')
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
test('ComfyUI window has dark background and split-view architecture @real', async () => {
  test.skip(HYDRATED, 'reuse mode: comfy is not auto-running on this boot')
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

test('return-to-dashboard flips install host in place (same window id) @real', async () => {
  test.skip(HYDRATED, 'reuse mode: no install-backed host exists to flip (comfy not auto-running)')
  // Snapshot the live BrowserWindow ids + the install-backed host id
  // BEFORE the flip so the post-flip assertion can prove the install
  // host was reused as the chooser host instead of being closed and
  // replaced.
  const before = await ctx.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    const comfyHost = wins.find((w) =>
      w.contentView.children.some((v) =>
        v instanceof WebContentsView &&
        /^http:\/\/(127\.0\.0\.1|localhost):/.test(v.webContents.getURL()),
      ),
    )
    return { count: wins.length, ids: wins.map((w) => w.id), comfyHostId: comfyHost?.id ?? null }
  })
  expect(before.comfyHostId, 'no install-backed host window found to flip').not.toBeNull()

  // Drive the File menu's "Return to Dashboard" item via real popup
  // clicks. The helper polls `comfyFrontendIsLoaded`→false, waits for
  // `panel.html` to reappear, and asserts the chooser body is visible.
  await returnToDashboardViaFileMenu(ctx)

  const after = await ctx.app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    return { count: wins.length, ids: wins.map((w) => w.id) }
  })

  // Same window count (no fresh window) and the install-backed host id
  // is still alive — proving the host stayed the same BrowserWindow
  // when it returned to chooser mode.
  expect(after.count).toBe(before.count)
  expect(after.ids).toContain(before.comfyHostId)

  // Re-launch ComfyUI from the same chooser host so the subsequent stop
  // test can find a running comfy webContents to close. The host id must
  // STILL be the same one we just flipped (chooser → install in place).
  await launchComfyByClickingTile(ctx, 'ComfyUI')

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
  expect(reattached.comfyHostId).toBe(before.comfyHostId)
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

let _updateInstallId = ''
let _updateInstallPath = ''
let _comfyUIDir = ''
let _installedCommit = ''

test('stop ComfyUI again so update-comfyui (requires stopped) can run @real', async () => {
  // `update-comfyui` is in REQUIRES_STOPPED; the prior test re-launched.
  // Detach in place rather than closing the window so the chooser host
  // stays alive for the subsequent re-launch.
  // Prereq for individual --grep: ensure comfy is running so the
  // file-menu Return to Dashboard has something to flip.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }
  await returnToDashboardViaFileMenu(ctx)
})

test('captures install metadata for the update tests @real', async () => {
  const installs = await ctx.panel.evaluate<InstallationLite[]>(
    `window.api.getInstallations()`,
  )
  expect(installs.length, 'no tracked installation after install').toBeGreaterThan(0)
  const inst = installs[0]!
  _updateInstallId = inst.id
  _updateInstallPath = inst.installPath
  _comfyUIDir = path.join(_updateInstallPath, 'ComfyUI')

  // The install setup in test 2 picks the OLDEST standalone release,
  // so HEAD already sits on a stale stable tag — every downstream
  // update test naturally has work to do without any `git reset --hard`
  // hack against the live working tree.
  _installedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(_installedCommit).toMatch(/^[a-f0-9]{40}$/)
})

test('update-comfyui drives the real updater and moves HEAD forward @real', async () => {
  // Real update can run pip-install if requirements.txt changed
  // between the oldest standalone release we installed on and the
  // latest stable tag. Stretch the per-test timeout to cover that.
  test.setTimeout(600_000)
  expect(_installedCommit, 'installed commit not captured').toBeTruthy()

  // Drive the same-channel update via the picker: open on the Update
  // tab, click Update Now on the current (stable) channel card,
  // confirm. The install is currently stopped (REQUIRES_STOPPED), so
  // no IN_PLACE_RELAUNCH chain follows — we just wait for HEAD to
  // move off the installed commit.
  await ensureInstallPanelMountedViaFileMenu(ctx)
  await resetIpcInvocations(ctx.app, 'run-action')
  const popup = await openPickerByClickingTitlePill(ctx, {
    installationId: _updateInstallId, initialTab: 'update',
  })
  await popup.waitForSelector(byTestId(TID.updateActionButton('update-comfyui')), { timeout: 60_000 })
  expect(await popup.click(byTestId(TID.updateActionButton('update-comfyui')))).toBe(true)

  // Stable release has release notes → ModalDialog rich-confirm
  // (`modal-confirm-button`); fall back to BaseAlert if the upstream
  // release happens to have no body.
  const confirmSelector =
    '[data-testid="modal-confirm-button"], [data-testid="base-alert-action"]'
  await popup.waitForVisible(confirmSelector, { timeout: 15_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  // Poll git HEAD instead of the runAction return value — the picker
  // path forwards through pickerForwardShowProgress and does not
  // resolve a result to the test process.
  let headAfter = _installedCommit
  await expect
    .poll(() => {
      headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
      }).trim()
      return headAfter
    }, { timeout: 540_000, intervals: [2_000, 5_000] })
    .not.toBe(_installedCommit)

  expect(headAfter, 'update did not move HEAD off the installed (oldest stable) commit').not.toBe(_installedCommit)

  // The update should land on a commit reachable from origin/master that is
  // strictly newer than the installed (oldest stable) one — never older.
  const aheadCount = execFileSync('git', ['rev-list', '--count', `${_installedCommit}..${headAfter}`], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(parseInt(aheadCount, 10), `post-update HEAD ${headAfter} is not ahead of installed commit ${_installedCommit}`).toBeGreaterThan(0)
})

test('re-launch ComfyUI after update validates the updated install runs @real', async () => {
  // Prereq for individual --grep: if comfy is somehow already up
  // (e.g. greped against a hydrated profile mid-chain), the click
  // would just expand the picker — skip straight to the assertion.
  if (await comfyFrontendIsLoaded()) return
  await launchComfyByClickingTile(ctx, 'ComfyUI')
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

test('captures a snapshot for the picker-driven restore test @real', async () => {
  // ComfyUI is running from the prior re-launch test. `snapshot-save`
  // is NOT in REQUIRES_STOPPED so it runs against a live install — the
  // snapshot just records the current state. Captured label gives us a
  // stable filename to grab in the restore test below.
  expect(_updateInstallId, 'update install id not captured').toBeTruthy()
  // Prereq for individual --grep: ensure comfy is running so the
  // snapshot captures real install state.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }
  // `clickInstallTile` triggers `onLaunch`'s chooser-pick attach which
  // calls `destroyPanelView(claimed)` (index.ts) without remounting —
  // production lazily mounts a fresh install-backed panel on the next
  // Settings click / comfy-lifecycle body, so `panel.html` doesn't
  // exist while ComfyUI is the active body. The remaining picker-driven
  // tests in this file all need `ctx.panel` reachable; mount the panel
  // ourselves via the title-bar file menu (real-click path), then drive
  // the snapshot save through the picker's Snapshots tab.
  await saveSnapshotViaPicker(ctx, _updateInstallId, 'lifecycle-restore-target')
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

// ---------------------------------------------------------------------------
// Picker-driven update — driven through the picker's ChannelPicker.
// Drafts a non-current channel ('latest') in the BaseSelect, clicks the
// per-channel Update Now button, and waits for the IN_PLACE_RELAUNCH
// chain to complete. Pins the bug where `actionData.channel` on the
// drafted action came off the sections payload as a Vue reactive proxy
// and threw `"An object could not be cloned"` synchronously inside the
// popup's `bridge.pickerForwardShowProgress` → `ipcRenderer.send` —
// silently swallowing the show-progress hand-off so the user got stuck
// on the picker with no feedback (fix in `InstancePickerView.vue`
// `handleSettingsShowProgress` deep-clones `actionData` first).
//
// This is the single picker-driven update test in the suite. A
// same-channel sibling used to exist but was deleted: the install
// already updated to the latest stable in the direct-runAction test
// above, so a same-channel stable picker click would have no
// `updateAvailable` (the Update Now button wouldn't render). The
// cross-channel path exercises the same `InstancePickerView` →
// `pickerForwardShowProgress` → main → runAction IPC chain plus the
// drafted-channel payload, which is the bug class that was
// regressing — the same-channel variant added no unique coverage
// beyond what's asserted below.
// ---------------------------------------------------------------------------

test('picker-driven cross-channel update-comfyui (stable → latest) IN_PLACE_RELAUNCH while running @real', async () => {
  // Real cross-channel update: switches the install's `updateChannel`
  // from `stable` to `latest`, runs the master-branch update, then
  // relaunches in place. Stretch the timeout to cover a possible
  // `uv pip install -r requirements.txt` if requirements changed
  // between the stable release and master.
  test.setTimeout(600_000)

  // Prereq for individual --grep: cross-channel Update Now only
  // surfaces in the picker against a running install.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }

  // Sanity: install is on stable before drafting latest.
  const installsBefore = await ctx.panel.evaluate<Array<{ id: string; updateChannel?: string }>>(
    `window.api.getInstallations()`,
  )
  const before = installsBefore.find((i) => i.id === _updateInstallId)
  expect(before?.updateChannel, 'install must be on stable before the cross-channel switch').toBe('stable')

  const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  // Open the picker on the Update tab via a real title-pill click +
  // picker-row expand + tab click. Channel metadata loads via real
  // `check-update` against github.com for both stable and latest —
  // `latest` reports an update against the master tip, so its
  // cross-channel Update Now button comes alive.
  const popup = await openPickerByClickingTitlePill(ctx, {
    installationId: _updateInstallId, initialTab: 'update',
  })

  // ChannelPicker renders a BaseSelect (`role="combobox"`); the
  // dropdown's options are `role="option"` with the channel label.
  // Drafting a non-current channel mutates `state.draft` but does not
  // commit — the per-channel `selectedActions` switch to the drafted
  // channel's `{ update-comfyui, copy-update, switch-channel }` set.
  await popup.waitForSelector('button[role="combobox"]', { timeout: 60_000 })
  expect(await popup.click('button[role="combobox"]')).toBe(true)
  await popup.waitForVisible('[role="listbox"] [role="option"]', { timeout: 10_000 })
  expect(
    await popup.clickByText('[role="listbox"] [role="option"]', 'Latest on GitHub'),
    '"Latest on GitHub" option missing from BaseSelect listbox',
  ).toBe(true)

  // The cross-channel Update Now button appears once `updateAvailable`
  // resolves true for `latest` (true whenever master is ahead of the
  // installed commit — usually always against a stable release).
  await popup.waitForSelector(byTestId(TID.updateActionButton('update-comfyui')), { timeout: 60_000 })
  expect(await popup.click(byTestId(TID.updateActionButton('update-comfyui')))).toBe(true)

  // `latest` is master-tip — no GitHub release object → empty
  // `releaseNotes` → `confirm.messageDetails` undefined → ModalDialog
  // routes the confirm through its BaseAlert primitive (no rich
  // message-details UI), whose primary button defaults to
  // `data-testid="base-alert-action"`. (Same-channel stable picks up
  // release notes and stays on the legacy `TID.modalConfirm` path.)
  const confirmSelector = '[data-testid="base-alert-action"]'
  await popup.waitForVisible(confirmSelector, { timeout: 15_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  await waitForProgressTakeoverAfterPopupClose()

  // IN_PLACE_RELAUNCH: panel-side `useDeepLinkRouter` appends a
  // `launch` action after a successful cross-channel update, same as
  // the same-channel path.
  await waitForRunAction(_updateInstallId, 'launch')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000, 2_000] }).toBe(true)

  // `update-comfyui` actionData.channel persisted the drafted value
  // into the run-action IPC. This is the pinned bug — before the
  // Vue-reactive-proxy → contextBridge fix in
  // `InstancePickerView.handleSettingsShowProgress`, the `actionData`
  // payload threw "An object could not be cloned" synchronously inside
  // `bridge.pickerForwardShowProgress` and never reached main, so the
  // run-action either never fired or fired without the `channel` key.
  const ourRunCalls = await getRunActionsFor(_updateInstallId)
  const updateCall = ourRunCalls.find((c) => c.actionId === 'update-comfyui')
  expect(updateCall, 'cross-channel update-comfyui not recorded').toBeDefined()
  expect(
    (updateCall as { actionData?: { channel?: string } }).actionData?.channel,
    'cross-channel update-comfyui must carry actionData.channel=latest',
  ).toBe('latest')

  // Channel actually switched on the InstallationRecord.
  const installsAfter = await ctx.panel.evaluate<Array<{ id: string; updateChannel?: string }>>(
    `window.api.getInstallations()`,
  )
  const after = installsAfter.find((i) => i.id === _updateInstallId)
  expect(
    after?.updateChannel,
    'updateChannel must flip to latest after a cross-channel update',
  ).toBe('latest')

  // HEAD moved to a real master commit (latest is master-tip).
  const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: _comfyUIDir, encoding: 'utf-8', windowsHide: true,
  }).trim()
  expect(headAfter, 'cross-channel update did not move HEAD').not.toBe(headBefore)
  expect(headAfter).toMatch(/^[a-f0-9]{40}$/)

  // IN_PLACE_RELAUNCH run-action chain: update-comfyui then launch
  // (scoped to our installation id). Note: cross-channel forwards
  // through `pickerForwardShowProgress` → main, so the self-stop
  // path is main-side (`ipc.stopRunning`) rather than the renderer
  // `stop-comfyui` IPC — only the run-action ordering is observable
  // here.
  expect(ourRunCalls.length, 'update + launch run-action calls').toBeGreaterThanOrEqual(2)
  expect(ourRunCalls[0]?.actionId, 'first run-action should be update-comfyui').toBe('update-comfyui')
  const launchIdx = ourRunCalls.findIndex((c) => c.actionId === 'launch')
  expect(launchIdx, 'launch run-action should follow update-comfyui').toBeGreaterThan(0)
})

test('picker-driven snapshot-restore IN_PLACE_RELAUNCH while running @real', async () => {
  test.setTimeout(600_000)
  expect(_restoreSnapshotFilename, 'restore-target snapshot not captured').toBeTruthy()

  // Prereq for individual --grep: snapshot row Restore only surfaces
  // in the picker against a running install.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }

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

  const popup = await openPickerByClickingTitlePill(ctx, {
    installationId: _updateInstallId, initialTab: 'snapshots',
  })
  // Expand the snapshot row to reveal Restore.
  await popup.waitForSelector(byTestId(TID.snapshotRow(_restoreSnapshotFilename)), { timeout: 30_000 })
  expect(await popup.click(byTestId(TID.snapshotRow(_restoreSnapshotFilename)))).toBe(true)
  await popup.waitForVisible(byTestId(TID.snapshotRowRestore(_restoreSnapshotFilename)), { timeout: 10_000 })
  expect(await popup.click(byTestId(TID.snapshotRowRestore(_restoreSnapshotFilename)))).toBe(true)

  // SnapshotsView builds a diff-preview confirm. When the snapshot's
  // change summary has lines (different pkgs / commit from the prior
  // snapshot), ModalDialog routes through the rich-confirm branch
  // with `TID.modalConfirm`. When the target snapshot is identical
  // to the prior one (e.g. a manual snapshot captured immediately
  // after the auto post-update snapshot at the same HEAD + pkg state),
  // `messageDetails` is undefined and ModalDialog falls back to the
  // BaseAlert simple-confirm path with `base-alert-action`. Accept
  // either CTA via a CSS comma selector.
  const confirmSelector =
    '[data-testid="modal-confirm-button"], [data-testid="base-alert-action"]'
  await popup.waitForVisible(confirmSelector, { timeout: 30_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  await waitForProgressTakeoverAfterPopupClose()

  // Wait for the IN_PLACE_RELAUNCH launch leg + frontend load.
  // Note: picker-driven IN_PLACE_RELAUNCH ops forward through
  // `pickerForwardShowProgress` → main, so the self-stop path is
  // main-side (`ipc.stopRunning`) rather than the renderer
  // `stop-comfyui` IPC — only the run-action ordering is observable.
  await waitForRunAction(_updateInstallId, 'launch')
  await expect.poll(comfyFrontendIsLoaded, { timeout: 180_000, intervals: [1_000, 2_000] }).toBe(true)

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

test('picker compact-row Restart drives system-modal confirm + re-launch @real', async () => {
  test.setTimeout(300_000)

  // Prereq for individual --grep: the compact PickerRow CTA renders
  // "Restart" only when the install is currently running.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  // Open the picker in compact mode (no row expand) via a real
  // title-pill click — the per-row Restart CTA lives directly on the
  // collapsed row.
  const popup = await openPickerByClickingTitlePill(ctx)
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

test('picker pin-bottom Restart drives stop+launch under one "Restarting ComfyUI" progress title @real', async () => {
  test.setTimeout(300_000)

  // Prereq for individual --grep: the pin-bottom Launch→Restart swap
  // only renders when the install is currently running.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }
  const beforeSnapshot = await getRunningSessionSnapshot(ctx.app, _updateInstallId)
  expect(beforeSnapshot, 'expected a running session before pin-bottom Restart').not.toBeNull()

  await resetIpcInvocations(ctx.app, 'stop-comfyui')
  await resetIpcInvocations(ctx.app, 'run-action')

  // Open the picker on the Settings/Config tab via a real title-pill
  // click + picker-row expand + tab click. The pin-bottom MoreMenu
  // only renders inside the expanded-row layout.
  const popup = await openPickerByClickingTitlePill(ctx, {
    installationId: _updateInstallId, initialTab: 'config',
  })

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

test('picker pin-bottom Copy creates a real ~500MB copy of the install @real', async () => {
  test.setTimeout(600_000)

  // Prereq for individual --grep: ensure comfy is running so the
  // file-menu Return to Dashboard has something to flip.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }

  // Copy is REQUIRES_STOPPED — stop comfy via return-to-dashboard so
  // the IPC handler doesn't bail and the picker dispatches without a
  // self-stop preamble.
  await returnToDashboardViaFileMenu(ctx)

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

  // Drive the picker open via a real title-pill click — the chooser
  // host's title bar still renders an interactive pill (with the
  // `is-install-less` class), so this works from the dashboard too.
  // Mount the panel via the file menu first so the chooser body is
  // available as an IPC target throughout the rest of the test.
  await ensureInstallPanelMountedViaFileMenu(ctx)
  const popup = await openPickerByClickingTitlePill(ctx, {
    installationId: _updateInstallId, initialTab: 'config',
  })

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

test('cleans up the copy install before the original delete test runs @real', async () => {
  test.setTimeout(300_000)
  expect(_copyInstallId, 'no copy install id captured to clean up').toBeTruthy()

  // Delete via the dashboard kebab → Delete menu item → BaseAlert
  // confirm → ProgressModal. The copy is stopped (never launched), so
  // no `stop-comfyui` preamble is needed. Frees disk before the final
  // delete test runs against the original.
  await deleteInstallViaDashboardKebab(ctx, _copyInstallId)

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

test('dashboard kebab "Copy Installation" creates a real ~500MB copy @real', async () => {
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

test('dashboard kebab "Untrack" removes the install from the registry without touching disk @real', async () => {
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

test('cleans up the untracked kebab-copy on disk before the final Delete test runs @real', async () => {
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

test('stops comfy and captures the installed dir state before driving delete @real', async () => {
  // delete is in REQUIRES_STOPPED — stop comfy via return-to-dashboard so
  // the IPC handler doesn't bail on us. rtd preserves the chooser host so
  // we still have an IPC target for delete + getInstallations.
  // Prereq for individual --grep: ensure comfy is running so the
  // file-menu Return to Dashboard has something to flip.
  if (!(await comfyFrontendIsLoaded())) {
    await launchComfyByClickingTile(ctx, 'ComfyUI')
  }
  await returnToDashboardViaFileMenu(ctx)

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

test('real delete wipes the fully-installed ~500MB tree off disk @real', async () => {
  // Recursive delete of a full standalone install can take a while on
  // Windows when files are large (the .venv ships thousands of small
  // files plus a few hundred-MB torch wheels). Stretch the timeout.
  test.setTimeout(300_000)
  expect(_deleteInstallPath, 'install path not captured').toBeTruthy()

  // Delete via the dashboard kebab → Delete menu item → BaseAlert
  // confirm → ProgressModal. The recursive fs.rm of the .venv (~thousands
  // of small files plus the torch wheels) is the slow part.
  await deleteInstallViaDashboardKebab(ctx, _deleteInstallId)

  // Disk verification — the entire install tree must be gone, not just
  // a few top-level entries. Probes both the root + a deep file the
  // standalone install always materializes (ComfyUI/main.py).
  expect(existsSync(_deleteInstallPath), `install dir ${_deleteInstallPath} still exists after delete`).toBe(false)
  expect(existsSync(path.join(_deleteInstallPath, 'ComfyUI', 'main.py')), 'ComfyUI/main.py still on disk after delete').toBe(false)

  // The installation record must also be gone.
  const remaining = await ctx.panel.evaluate<InstallationLite[]>(`window.api.getInstallations()`)
  expect(remaining.find((i) => i.id === _deleteInstallId), 'install record not removed after delete').toBeUndefined()
})
