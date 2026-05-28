/**
 * Helpers for the @real lifecycle suite.
 *
 * Every helper in this file drives prerequisites via real DOM clicks /
 * keypresses — never through `__e2e.*`, `window.api.*`, or seeded harness
 * state. See `e2e/AGENTS.md` for the @real contract.
 *
 * The goal: a @real test file's `beforeAll` can call `ensureInstalledAndLaunched(ctx)`
 * and land in a "real user has installed and launched ComfyUI" state without
 * the test itself needing to re-walk the consent → pick-local → Configure
 * → Continue → wait dance.
 *
 * `LIFECYCLE_REUSE_DIR` is the one sanctioned local-dev speedup: when set,
 * `ensureInstalledAndLaunched` detects an existing install on the persisted
 * profile and skips the ~500 MB redownload. CI always runs from a fresh
 * temp dir.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect } from '@playwright/test'
import type { AppContext } from '../launchApp'
import { clickInstallTile, expectChooserVisible } from './chooserHelpers'
import { systemModalPage, titlePopupPage, waitForWebContents, type WebContentsPage } from './cdpPages'
import { ensureInstallPanelView as e2eEnsureInstallPanelView } from './devHooks'
import { byTestId, TID } from './testIds'

/** Picker tabs that can be opened via the title pill helpers. The
 *  literal keys here mirror `ComfyUISettingsTab` in
 *  `src/renderer/src/components/settings/ComfyUISettingsContent.vue`. */
export type PickerTabKey = 'update' | 'snapshots' | 'config'

/** Tab label fallbacks for `.settings-v2-tab` text matching. The Vue
 *  source uses i18n keys with these English fallbacks; locales merge in
 *  asynchronously so the English text is what the picker renders during
 *  the e2e harness boot. */
const PICKER_TAB_LABEL: Record<PickerTabKey, string> = {
  update: 'Update',
  snapshots: 'Snapshots',
  config: 'Startup Args',
}

/** Fully-installed standalone ComfyUI install state. Populated by
 *  `freshInstallStandaloneCpu` (real flow) or `hydrateInstallFromDisk`
 *  (reuse-mode shortcut). */
export interface HydratedInstall {
  id: string
  installPath: string
  comfyUIDir: string
  /** git rev-parse HEAD at hydration time. Empty when the working tree
   *  hasn't been touched yet. */
  installedCommit: string
}

interface InstallationLite {
  id: string
  installPath: string
}

/** True iff a webContents with a localhost URL exists and is loaded —
 *  the canonical "ComfyUI is up" signal across @real tests. */
export async function comfyFrontendIsLoaded(ctx: AppContext): Promise<boolean> {
  return ctx.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().some((wc) =>
      /^http:\/\/(127\.0\.0\.1|localhost):/.test(wc.getURL()) && !wc.isLoading(),
    ),
  )
}

/** Drive the first-use takeover end-to-end to a fully-installed standalone
 *  ComfyUI on the OLDEST stable release (so downstream update tests always
 *  see "Update available"). On Windows pins the CPU variant; on macOS/Linux
 *  trusts the recommended variant the host detected.
 *
 *  Returns the hydrated install state.
 *
 *  Inputs: real DOM clicks / value-set events on visible form fields.
 *  No `__e2e.*` writes. No `window.api.*` mutations. Reads via
 *  `window.api.getInstallations()` are observation only and allowed. */
export async function freshInstallStandaloneCpu(
  ctx: AppContext,
): Promise<HydratedInstall> {
  // -------------------------------------------------------------
  // Step 1 — first-use start screen
  // -------------------------------------------------------------
  await ctx.panel.waitForVisible('.start-hero', { timeout: 15_000 })
  await ctx.panel.waitForVisible('[data-testid="first-use-pick-local"]')

  expect(await ctx.panel.click('[data-testid="first-use-pick-local"]')).toBe(true)
  await ctx.panel.waitForVisible('[data-testid="first-use-express-install"]', { timeout: 5_000 })

  // Express defaults to checked on Local pick — uncheck to force the
  // New Install Tier 3 takeover path (covered here) instead of the
  // express short-circuit (covered by FirstUseTakeover.test.ts unit).
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

  // -------------------------------------------------------------
  // Step 2 — New Install Configure screen
  // -------------------------------------------------------------
  await ctx.panel.waitForVisible('.brand-takeover-root', { timeout: 10_000 })
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

  // Expand Advanced + pick the OLDEST stable release so downstream
  // update tests have something to update to.
  expect(await ctx.panel.click('.config-advanced__summary')).toBe(true)
  await ctx.panel.waitForSelector('#source-fields button[role="combobox"]', { timeout: 5_000 })
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
    'failed to click oldest release option',
  ).toBe(true)

  // Variant re-resolves when release changes — wait for Continue to come back.
  await ctx.panel.waitFor(
    async () => ctx.app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('panel.html'))
      if (!wc) return false
      return wc.executeJavaScript(`(() => {
        const btn = document.querySelector('.brand-primary.config-continue')
        return !!btn && !btn.disabled
      })()`) as Promise<boolean>
    }),
    { timeout: 60_000, message: 'Continue never re-enabled after picking oldest release' },
  )

  // CPU pin on Windows only (macOS publishes only mac-mps, linux only GPU variants).
  if (process.platform === 'win32') {
    await ctx.panel.waitForSelector('.brand-variant-row', { timeout: 5_000 })
    expect(
      await ctx.panel.clickByText('.brand-variant-row', 'CPU'),
      'CPU variant row clicked',
    ).toBe(true)
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

  // -------------------------------------------------------------
  // Step 3 — Continue + wait for install + auto-launch
  // -------------------------------------------------------------
  expect(await ctx.panel.clickByText('.brand-primary', 'Continue')).toBe(true)
  await ctx.panel.waitForVisible('.brand-progress', { timeout: 10_000 })

  // ~500 MB download + extract + auto-launch. Generous timeout because
  // CI runners and dev boxes vary wildly.
  await expect
    .poll(() => comfyFrontendIsLoaded(ctx), { timeout: 480_000, intervals: [1_000, 2_000] })
    .toBe(true)

  return await captureInstallStateFromDisk(ctx)
}

/** True iff the install on disk has the minimal pieces `handleLaunch`
 *  needs: `ComfyUI/main.py` and either `ComfyUI/.venv/Scripts/python.exe`
 *  (Windows) / `ComfyUI/.venv/bin/python3` (POSIX) — matches the layout
 *  produced by `createEnv` in `src/main/sources/standalone/install.ts`.
 *
 *  A registry entry whose disk state is missing these pieces is
 *  considered corrupt (typical cause: a prior run's terminal delete
 *  test was interrupted partway through wiping the install tree) and
 *  must not be silently hydrated — launching it would fail with the
 *  "no Python environment found" error and the test would time out
 *  blaming the launch, not the corrupt state. */
function isLaunchableInstall(installPath: string): boolean {
  const comfyMain = path.join(installPath, 'ComfyUI', 'main.py')
  const venvPython = process.platform === 'win32'
    ? path.join(installPath, 'ComfyUI', '.venv', 'Scripts', 'python.exe')
    : path.join(installPath, 'ComfyUI', '.venv', 'bin', 'python3')
  return existsSync(comfyMain) && existsSync(venvPython)
}

/** Read the live install state off disk (id + path from
 *  `getInstallations`, commit from `git rev-parse`). Used by both
 *  `freshInstallStandaloneCpu` (after a fresh install) and
 *  `hydrateInstallFromDisk` (reuse-mode). */
async function captureInstallStateFromDisk(ctx: AppContext): Promise<HydratedInstall> {
  const installs = await ctx.panel.evaluate<Array<InstallationLite & { copiedFromName?: string }>>(
    `window.api.getInstallations()`,
  )
  // Prefer the original install over any copies the lifecycle suite
  // leaves behind. Copies carry `copiedFromName`; the source install
  // does not. Within each group prefer entries whose disk state is
  // actually launchable so a partially-deleted leftover from a prior
  // run doesn't shadow a fresh source install that's still intact.
  const locals = installs.filter((i) => typeof i.installPath === 'string' && i.installPath.length > 0)
  const sources = locals.filter((i) => !i.copiedFromName)
  const pickFrom = sources.length > 0 ? sources : locals
  const local = pickFrom.find((i) => isLaunchableInstall(i.installPath)) ?? pickFrom[0]
  if (!local) throw new Error('no local install record found in getInstallations()')

  const comfyUIDir = path.join(local.installPath, 'ComfyUI')
  let installedCommit = ''
  try {
    installedCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: comfyUIDir, encoding: 'utf-8', windowsHide: true,
    }).trim()
  } catch { /* partial hydration — git dir may not exist on a half-built profile */ }

  return {
    id: local.id,
    installPath: local.installPath,
    comfyUIDir,
    installedCommit,
  }
}

/** Click the named install tile on the chooser and wait for ComfyUI to load. */
export async function launchComfyByClickingTile(
  ctx: AppContext,
  nameSubstring: string,
): Promise<void> {
  await clickInstallTile(ctx.panel, nameSubstring)
  await expect
    .poll(() => comfyFrontendIsLoaded(ctx), { timeout: 180_000, intervals: [1_000, 2_000] })
    .toBe(true)
}

/** Click the title-bar instance pill → picker → `.picker-home` Home
 *  icon to flip an install-backed host back to the chooser body. The
 *  Home icon dispatches `bridge.activate('return-to-dashboard')` —
 *  the production equivalent of the removed file-menu item (the
 *  install-host file menu was trimmed in #497, with the Home icon in
 *  the picker chips row as the sole escape hatch).
 *
 *  Waits for the chooser body to reappear (in-place flip — same window
 *  id, panel.html is rebuilt). */
export async function returnToDashboardViaPickerHome(ctx: AppContext): Promise<void> {
  await ctx.titleBar.waitForVisible('.title-install-pill', { timeout: 15_000 })
  expect(await ctx.titleBar.click('.title-install-pill'), 'title-install-pill click dispatched').toBe(true)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')

  const popup = titlePopupPage(ctx.app)
  // `.picker-home` only renders on install-hosted pickers (the
  // dashboard's own picker hides it — `isInstallHost` v-if). The
  // test surface comfy is running, so the picker IS install-hosted.
  await popup.waitForVisible('.picker-home', { timeout: 10_000 })
  expect(await popup.click('.picker-home'), '.picker-home click').toBe(true)

  // `returnToDashboard` confirms the "Stop & Return" prompt on one
  // of two surfaces for a running local install — the install-backed
  // panel webContents when it is still alive (Settings / lifecycle
  // visited since launch), otherwise a shell system modal because
  // the chooser-pick attach destroyed the panelView. Both render a
  // BaseAlert with the same TID; poll either surface. Either page's
  // `exists` throws while its webContents doesn't exist yet, so wrap
  // each probe in a swallow-on-throw.
  const sysModal = systemModalPage(ctx.app)
  const probe = async (page: WebContentsPage): Promise<boolean> => {
    try { return await page.exists(byTestId(TID.baseAlertAction)) }
    catch { return false }
  }
  let confirmSurface: WebContentsPage | null = null
  await expect.poll(async () => {
    if (await probe(ctx.panel)) { confirmSurface = ctx.panel; return true }
    if (await probe(sysModal)) { confirmSurface = sysModal; return true }
    return false
  }, { timeout: 10_000, intervals: [200, 400, 800], message: 'return-to-dashboard confirm did not appear on panel or system modal' }).toBe(true)
  expect(await confirmSurface!.click(byTestId(TID.baseAlertAction)), 'return-to-dashboard confirm clicked').toBe(true)

  // After the flip the comfyView no longer loads a localhost URL and
  // panel.html is rebuilt as the chooser body.
  await expect
    .poll(() => comfyFrontendIsLoaded(ctx), { timeout: 30_000, intervals: [500] })
    .toBe(false)
  await waitForWebContents(ctx.app, 'panel.html')
  await expectChooserVisible(ctx.panel)
}

/** Top-level prereq for any @real test that needs a fully-installed
 *  + currently-launched ComfyUI. Hydrates from `LIFECYCLE_REUSE_DIR`
 *  when set (skipping the ~500 MB download), otherwise drives a real
 *  install via `freshInstallStandaloneCpu`.
 *
 *  Always leaves the app in the same observable state on return:
 *  ComfyUI is running, the install-backed panel view is mounted, and
 *  the returned `HydratedInstall` matches what's on disk. */
export async function ensureInstalledAndLaunched(
  ctx: AppContext,
): Promise<HydratedInstall> {
  const reuseDir = process.env['LIFECYCLE_REUSE_DIR']
  if (reuseDir) {
    // Wait briefly for the chooser to mount. On a hydrated profile
    // firstUseCompleted is already true so we land on the chooser body
    // directly. On an empty reuse dir we'd fall through to the install path.
    try {
      await ctx.panel.waitForVisible('.chooser-view', { timeout: 10_000 })
    } catch { /* fresh boot may still be on the first-use takeover */ }

    let hydrated: HydratedInstall | null = null
    try {
      hydrated = await captureInstallStateFromDisk(ctx)
    } catch { /* no install yet — fall through */ }

    // Skip hydration when the picked install isn't actually launchable
    // on disk (typical cause: a prior suite run's terminal delete test
    // was interrupted and left the install tree in a partial state).
    // Clicking the tile would fail with the "no Python environment
    // found" error and the test would time out blaming the launch.
    // Fall through to a fresh install instead.
    if (hydrated && !isLaunchableInstall(hydrated.installPath)) {
      console.log(`[lifecycle-harness] hydration skipped — install at ${hydrated.installPath} is missing ComfyUI/main.py or .venv (likely partial-delete leftover from a prior run); running fresh install`)
      hydrated = null
    }

    if (hydrated) {
      // Hydrated profile: launch the existing install via real click
      // and let the test proceed from a "ComfyUI running" surface.
      await launchComfyByClickingTile(ctx, 'ComfyUI')
      await ensureInstallPanelMounted(ctx, hydrated.id)
      // Re-capture so installedCommit reflects the post-launch HEAD
      // (no-op on stable installs, useful when the previous run left
      // the working tree at a different commit).
      return await captureInstallStateFromDisk(ctx)
    }
  }

  // Cold start: drive the full first-use install. The install flow
  // auto-launches into ComfyUI as its terminal step.
  const installed = await freshInstallStandaloneCpu(ctx)
  // Auto-launch dropped the panel.html (chooser-pick attach destroys
  // it). Rebuild it so subsequent ctx.panel.evaluate calls land.
  await ensureInstallPanelMounted(ctx, installed.id)
  return installed
}

/** Force-build the install-backed `panel.html` so subsequent
 *  `ctx.panel.evaluate` reads (`window.api.getInstallations`,
 *  `window.api.getSnapshots`, …) reach a live renderer.
 *
 *  After a chooser-pick attach the install-backed PanelApp is
 *  destroyed (`destroyPanelView(claimed)` in `main/index.ts`) and only
 *  re-built on demand — Settings, comfy-lifecycle progress, etc. The
 *  install-host file menu was trimmed (#497) so there is no longer a
 *  user-facing gesture whose sole job is "mount the panel", and the
 *  picker popup is its own webContents (does NOT trigger panel mount).
 *
 *  Resolves the gap with `__e2e.ensureInstallPanelView(installationId)`,
 *  which invokes the same idempotent `ensurePanelView(..., 'comfy-lifecycle')`
 *  production code path the next user interaction would run. This is a
 *  *read-trigger* primitive — no fake test data is seeded — and is
 *  scoped to this support file so test bodies never reach for `__e2e.*`
 *  directly. No-op when the panel is already mounted. */
export async function ensureInstallPanelMounted(
  ctx: AppContext, installationId: string,
): Promise<void> {
  try {
    await waitForWebContents(ctx.app, 'panel.html', 1_000)
    return
  } catch { /* fall through to the forced mount */ }
  expect(
    await e2eEnsureInstallPanelView(ctx.app, installationId),
    'main rejected ensurePanelView — installation entry missing or window destroyed',
  ).toBe(true)
  await waitForWebContents(ctx.app, 'panel.html', 10_000)
}

/** Click the title-bar `.title-install-pill` to open the InstancePicker
 *  popup. The pill renders on both install-backed and install-less
 *  (chooser) hosts as an interactive `<button>` so this works regardless
 *  of which body is currently active.
 *
 *  When `opts.installationId` is set, also expand that install's
 *  picker row to enter the per-install settings panel. When
 *  `opts.initialTab` is set, click that tab once the settings panel is
 *  expanded.
 *
 *  Returns the popup webContents page handle so callers can keep
 *  driving clicks against the picker without re-resolving the marker. */
export async function openPickerByClickingTitlePill(
  ctx: AppContext,
  opts: { installationId?: string; initialTab?: PickerTabKey } = {},
): Promise<WebContentsPage> {
  await ctx.titleBar.waitForVisible('.title-install-pill', { timeout: 15_000 })
  expect(await ctx.titleBar.click('.title-install-pill'), 'title-install-pill click dispatched').toBe(true)
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  if (opts.installationId) {
    const rowSel = byTestId(TID.pickerRow(opts.installationId))
    await popup.waitForVisible(rowSel, { timeout: 15_000 })
    expect(await popup.click(rowSel), `picker-row click for ${opts.installationId}`).toBe(true)
  }

  if (opts.initialTab) {
    const label = PICKER_TAB_LABEL[opts.initialTab]
    await popup.waitFor(
      async () => {
        const texts = await popup.allText('.settings-v2-tab')
        return texts.some((t) => t.includes(label))
      },
      { timeout: 15_000, message: `picker tab "${label}" never appeared` },
    )
    expect(
      await popup.clickByText('.settings-v2-tab', label),
      `picker tab "${label}" clicked`,
    ).toBe(true)
  }

  return popup
}

/** Save a snapshot via the picker: open the picker, switch to the
 *  Snapshots tab, click the dashed "Save Snapshot" rail box, fill the
 *  prompt with `label`, confirm.
 *
 *  Internally ensures `panel.html` is mounted first (the picker's
 *  IPC reads of installations / snapshots flow through the panel
 *  webContents — callers expect it alive after this returns). Polls
 *  `getSnapshots` until the new label appears so the caller can read
 *  metadata immediately after.
 *
 *  `label` must be non-empty — `dialogs.prompt` allows blank but the
 *  callers in this suite always identify their target by label. */
export async function saveSnapshotViaPicker(
  ctx: AppContext,
  installId: string,
  label: string,
): Promise<void> {
  await ensureInstallPanelMounted(ctx, installId)
  const popup = await openPickerByClickingTitlePill(ctx, {
    installationId: installId,
    initialTab: 'snapshots',
  })

  await popup.waitForVisible('.snapshots-rail-save-box', { timeout: 30_000 })
  expect(await popup.click('.snapshots-rail-save-box'), 'snapshots-rail-save-box click').toBe(true)

  // `handleSave` opens a `dialogs.prompt` — BasePrompt rendered
  // inside the popup webContents.
  await popup.waitForVisible(byTestId(TID.basePromptInput), { timeout: 10_000 })
  await popup.evaluate<void>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(byTestId(TID.basePromptInput))})
      if (!el) throw new Error('snapshot label prompt input missing')
      el.value = ${JSON.stringify(label)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })()`,
  )
  expect(await popup.click(byTestId(TID.basePromptAction)), 'snapshot save confirm clicked').toBe(true)

  interface SnapshotListLite { snapshots: { label?: string; filename: string }[] }
  await expect
    .poll(async () => {
      const list = await ctx.panel.evaluate<SnapshotListLite>(
        `window.api.getSnapshots(${JSON.stringify(installId)})`,
      )
      return list.snapshots.some((s) => s.label === label)
    }, { timeout: 60_000, intervals: [500, 1_000] })
    .toBe(true)
}

/** Delete an install via the dashboard kebab → Delete menu item →
 *  confirm. Routes through `useInstallContextMenu`'s `id === 'delete'`
 *  branch which mounts `modal.confirm` (BaseAlert simple-confirm,
 *  `confirmStyle: 'danger'`) and then `onShowProgress` (ProgressModal
 *  takes over the panel body).
 *
 *  Polls `getInstallations` until `installId` is gone. Real `fs.rm`
 *  of a fully-installed ~500MB standalone tree (esp. Windows `.venv`)
 *  takes a while; the timeout is generous. */
export async function deleteInstallViaDashboardKebab(
  ctx: AppContext,
  installId: string,
): Promise<void> {
  await expectChooserVisible(ctx.panel)
  const kebabSel = byTestId(TID.dashboardTileKebab(installId))
  await ctx.panel.waitForVisible(kebabSel, { timeout: 15_000 })
  expect(await ctx.panel.click(kebabSel), `dashboard-tile-kebab click for ${installId}`).toBe(true)

  const deleteItemSel = byTestId(TID.contextMenuItem('delete'))
  await ctx.panel.waitForVisible(deleteItemSel, { timeout: 5_000 })
  expect(await ctx.panel.click(deleteItemSel), 'context-menu Delete click').toBe(true)

  // Simple BaseAlert confirm — no `messageDetails`, danger style.
  await ctx.panel.waitForVisible(byTestId(TID.baseAlertAction), { timeout: 10_000 })
  expect(await ctx.panel.click(byTestId(TID.baseAlertAction)), 'delete confirm clicked').toBe(true)

  interface InstallationLite { id: string }
  await expect
    .poll(async () => {
      const installs = await ctx.panel.evaluate<InstallationLite[]>(
        `window.api.getInstallations()`,
      )
      return installs.some((i) => i.id === installId)
    }, { timeout: 300_000, intervals: [1_000, 2_000] })
    .toBe(false)
}
