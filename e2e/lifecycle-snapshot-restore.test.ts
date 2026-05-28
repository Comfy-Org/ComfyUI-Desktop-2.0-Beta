/**
 * Lifecycle E2E: live `snapshot-restore` against real git repos.
 *
 * Goes beyond IPC wiring: pre-stages two local bare git repos
 * (ComfyUI + one custom node), clones them into a fake installation
 * dir at "newer" commit B, seeds a snapshot pointing at "older"
 * commit A, then drives `runAction('snapshot-restore', …)` and asserts:
 *   - the ComfyUI working tree HEAD moved from B → A
 *   - the custom node working tree HEAD moved from B → A
 *   - a fresh `post-restore` snapshot was captured
 *
 * The seeded snapshot has `skipPipSync: true` so the live restore
 * skips the pip phase (it would otherwise demand a real `uv` +
 * Python env). All other restore work (git checkout for ComfyUI
 * and per-node checkout via `restoreCustomNodes`) runs for real
 * against the bare-repo `origin`s on disk.
 */

import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { titlePopupPage, waitForWebContents } from './support/cdpPages'
import { byTestId, TID } from './support/testIds'

let ctx: AppContext
let stagedInstallPath = ''
let comfyOriginPath = ''
let nodeOriginPath = ''
let workTmpPath = ''

let comfyCommitA = ''
let comfyCommitB = ''
let nodeCommitA = ''
let nodeCommitB = ''

const INSTALL_ID = 'inst-snapshot-restore'
const INSTALL_NAME = 'Snapshot Restore Test'
const NODE_DIRNAME = 'restore-test-node'
const SEEDED_BASE_TAG = 'v0.3.10'

interface SnapshotSummary {
  filename: string
  trigger: string
  label: string | null
  [key: string]: unknown
}

interface SnapshotListResult {
  snapshots: SnapshotSummary[]
  totalCount: number
}

interface RunActionResult {
  ok: boolean
  message?: string
  navigate?: string
}

function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Lifecycle Test',
      GIT_AUTHOR_EMAIL: 'lifecycle@example.com',
      GIT_COMMITTER_NAME: 'Lifecycle Test',
      GIT_COMMITTER_EMAIL: 'lifecycle@example.com',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  }).trim()
}

/**
 * Build a local bare repo (`<root>/<name>.git`) plus a throw-away working
 * clone, push two commits to `master`, and return the SHAs.
 */
async function buildTwoCommitRepo(
  root: string,
  name: string,
  firstFile: { name: string; content: string },
  secondFile: { name: string; content: string },
): Promise<{ originPath: string; commitA: string; commitB: string }> {
  const originPath = path.join(root, `${name}.git`)
  await mkdir(originPath, { recursive: true })
  gitIn(originPath, ['init', '--quiet', '--bare', '--initial-branch=master'])

  const workPath = path.join(root, `${name}-work`)
  await mkdir(workPath, { recursive: true })
  gitIn(workPath, ['init', '--quiet', '--initial-branch=master'])
  gitIn(workPath, ['remote', 'add', 'origin', originPath])

  await writeFile(path.join(workPath, firstFile.name), firstFile.content)
  gitIn(workPath, ['add', '.'])
  gitIn(workPath, ['commit', '--quiet', '-m', 'A: initial'])
  const commitA = gitIn(workPath, ['rev-parse', 'HEAD'])
  gitIn(workPath, ['push', '--quiet', 'origin', 'master'])

  await writeFile(path.join(workPath, secondFile.name), secondFile.content)
  gitIn(workPath, ['add', '.'])
  gitIn(workPath, ['commit', '--quiet', '-m', 'B: follow-up'])
  const commitB = gitIn(workPath, ['rev-parse', 'HEAD'])
  gitIn(workPath, ['push', '--quiet', 'origin', 'master'])

  return { originPath, commitA, commitB }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  workTmpPath = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-snapshot-restore-e2e-'))

  // Two bare repos: simulated ComfyUI + simulated custom node.
  const comfy = await buildTwoCommitRepo(
    workTmpPath,
    'comfyui-origin',
    { name: 'README.md', content: 'comfyui v1\n' },
    { name: 'README.md', content: 'comfyui v2\n' },
  )
  comfyOriginPath = comfy.originPath
  comfyCommitA = comfy.commitA
  comfyCommitB = comfy.commitB

  const node = await buildTwoCommitRepo(
    workTmpPath,
    'restore-node-origin',
    { name: 'node.py', content: '# v1\n' },
    { name: 'node.py', content: '# v2\n' },
  )
  nodeOriginPath = node.originPath
  nodeCommitA = node.commitA
  nodeCommitB = node.commitB

  // Build the fake installation: ComfyUI clone + custom_nodes/<node>.
  // Both start at the NEWER commit B; restore should move them to A.
  stagedInstallPath = path.join(workTmpPath, 'install')
  await mkdir(stagedInstallPath, { recursive: true })

  const comfyuiDir = path.join(stagedInstallPath, 'ComfyUI')
  gitIn(workTmpPath, ['clone', '--quiet', comfyOriginPath, comfyuiDir])
  // Force HEAD onto commit B explicitly — `git clone` already lands on B
  // (the most recent commit on master), but call it out so the intent is
  // greppable from the test.
  gitIn(comfyuiDir, ['checkout', '--quiet', comfyCommitB])

  const customNodesDir = path.join(comfyuiDir, 'custom_nodes')
  await mkdir(customNodesDir, { recursive: true })
  const stagedNodeDir = path.join(customNodesDir, NODE_DIRNAME)
  gitIn(customNodesDir, ['clone', '--quiet', nodeOriginPath, NODE_DIRNAME])
  gitIn(stagedNodeDir, ['checkout', '--quiet', nodeCommitB])

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: INSTALL_ID,
        name: INSTALL_NAME,
        installPath: stagedInstallPath,
        sourceId: 'standalone',
        status: 'installed',
        snapshots: [
          {
            trigger: 'manual',
            label: 'restore-target',
            comfyui: {
              ref: comfyCommitA,
              commit: comfyCommitA,
              releaseTag: SEEDED_BASE_TAG,
              variant: 'cpu',
              baseTag: SEEDED_BASE_TAG,
              commitsAhead: 0,
            },
            customNodes: [
              {
                id: NODE_DIRNAME,
                type: 'git',
                dirName: NODE_DIRNAME,
                enabled: true,
                commit: nodeCommitA,
                url: nodeOriginPath,
              },
            ],
            pipPackages: {},
            skipPipSync: true,
            updateChannel: 'stable',
          },
        ],
      },
    ],
  })
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (workTmpPath) await rm(workTmpPath, { recursive: true, force: true })
})

test('seeded HEADs start at commit B (sanity) @ci', async () => {
  const comfyHead = gitIn(path.join(stagedInstallPath, 'ComfyUI'), ['rev-parse', 'HEAD'])
  const nodeHead = gitIn(
    path.join(stagedInstallPath, 'ComfyUI', 'custom_nodes', NODE_DIRNAME),
    ['rev-parse', 'HEAD'],
  )
  expect(comfyHead).toBe(comfyCommitB)
  expect(nodeHead).toBe(nodeCommitB)
})

test('snapshot-restore moves ComfyUI + node HEAD back to commit A @ci', async () => {
  const list = await ctx.panel.evaluate<SnapshotListResult>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)})`,
  )
  expect(list.snapshots.length, 'no seeded snapshot found').toBeGreaterThan(0)
  // The seeded `manual` snapshot is the only one on disk pre-restore.
  const target = list.snapshots.find((s) => s.trigger === 'manual' && s.label === 'restore-target')
  expect(target, 'seeded restore-target snapshot missing from list').toBeDefined()

  const result = await ctx.panel.evaluate<RunActionResult>(
    `window.api.runAction(
       ${JSON.stringify(INSTALL_ID)},
       'snapshot-restore',
       ${JSON.stringify({ file: target!.filename })}
     )`,
  )
  expect(result.ok, `snapshot-restore failed: ${result.message ?? ''}`).toBe(true)

  const comfyHead = gitIn(path.join(stagedInstallPath, 'ComfyUI'), ['rev-parse', 'HEAD'])
  expect(comfyHead, 'ComfyUI HEAD did not move to commit A after restore').toBe(comfyCommitA)

  const nodeHead = gitIn(
    path.join(stagedInstallPath, 'ComfyUI', 'custom_nodes', NODE_DIRNAME),
    ['rev-parse', 'HEAD'],
  )
  expect(nodeHead, 'custom node HEAD did not move to commit A after restore').toBe(nodeCommitA)
})

test('restore captures a post-restore snapshot @ci', async () => {
  // After a successful restore, `actions.ts` calls `saveSnapshot(... 'post-restore')`.
  // Poll because the post-restore save runs after `update(restoreState)` returns
  // — the runAction call already awaited the action result, but the snapshot
  // count update happens on a follow-up tick.
  await expect
    .poll(
      async () =>
        ctx.panel.evaluate<SnapshotListResult>(
          `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)})`,
        ),
      { timeout: 10_000, intervals: [200, 500] },
    )
    .toMatchObject({
      snapshots: expect.arrayContaining([
        expect.objectContaining({ trigger: 'post-restore' }),
      ]) as unknown,
    })
})

/**
 * Picker-driven restore: drives the same snapshot-restore action through
 * the instance-picker UI and asserts the inline top-card UX — restoring
 * state visible immediately, success state appears, save CTA returns
 * once the op auto-dismisses.
 *
 * Distinct from the test above which calls `window.api.runAction` directly:
 * this exercises the picker-bridge → `pickerStartBackgroundOp` →
 * `_activeOperationStatus` broadcast → SnapshotsView render loop end-to-end.
 *
 * The install is NOT running here (no ComfyUI process) so we don't hit the
 * IN_PLACE_RELAUNCH leg — the op completes in place and we observe just
 * the op-card terminal states. The actual git-checkout work is identical
 * to the earlier test; we don't re-assert HEAD movement (that's covered).
 */
// TODO(#621): snapshot-row testid for the freshly captured `post-restore-*`
// row never appears (10s timeout). The earlier static-row tests in this
// file pass; the picker-driven path needs investigation.
test.skip('picker-driven restore surfaces inline op-card + auto-dismisses on success @ci', async () => {
  test.setTimeout(120_000)

  // The earlier `snapshot-restore moves … back to commit A` test already
  // performed a restore via runAction. A `post-restore` snapshot is on
  // disk now; pick that as the target so we have a row to expand.
  const list = await ctx.panel.evaluate<SnapshotListResult>(
    `window.api.getSnapshots(${JSON.stringify(INSTALL_ID)})`,
  )
  const target = list.snapshots.find((s) => s.trigger === 'post-restore')
    ?? list.snapshots[0]
  expect(target, 'no snapshot to restore in picker test').toBeDefined()

  await ctx.panel.evaluate<boolean>(
    `(() => {
      window.api.openInstancePicker({
        installationId: ${JSON.stringify(INSTALL_ID)},
        initialTab: 'snapshots',
      })
      return true
    })()`,
  )
  await waitForWebContents(ctx.app, 'comfyTitlePopup.html')
  const popup = titlePopupPage(ctx.app)

  // Expand the target row, click Restore, accept the confirm modal.
  await popup.waitForSelector(byTestId(TID.snapshotRow(target!.filename)), { timeout: 30_000 })
  expect(await popup.click(byTestId(TID.snapshotRow(target!.filename)))).toBe(true)
  await popup.waitForVisible(byTestId(TID.snapshotRowRestore(target!.filename)), { timeout: 10_000 })
  expect(await popup.click(byTestId(TID.snapshotRowRestore(target!.filename)))).toBe(true)

  // SnapshotsView's confirm path: rich-confirm when the snapshot has a
  // change summary, BaseAlert when not — accept either.
  const confirmSelector = '[data-testid="modal-confirm-button"], [data-testid="base-alert-action"]'
  await popup.waitForVisible(confirmSelector, { timeout: 15_000 })
  expect(await popup.click(confirmSelector)).toBe(true)

  // The inline op-card replaces the dashed "Save New Snapshot" slot at
  // the top of the rail. Wait for it to appear (in-flight state is the
  // first variant rendered).
  await popup.waitForVisible(byTestId(TID.snapshotsOpCard), { timeout: 15_000 })

  // The header label switches to "Restoring snapshot" while the op is in flight.
  const labelText = await popup.evaluate<string>(
    `document.querySelector('.snapshots-rail-node.is-save .snapshots-rail-label')?.textContent ?? ''`,
  )
  expect(labelText.trim()).toMatch(/Restoring snapshot/i)

  // Poll until the success state lands (the card grows the
  // `.is-op-success` border + the header reads "Snapshot restored").
  await expect
    .poll(
      async () =>
        popup.evaluate<boolean>(
          `!!document.querySelector('.snapshots-rail-save-box.is-op-success')`,
        ),
      { timeout: 60_000, intervals: [500, 1_000] },
    )
    .toBe(true)

  // After the 1.8s success latch, the card clears and the Save CTA returns.
  await expect
    .poll(
      async () =>
        popup.evaluate<boolean>(
          `!!document.querySelector('.snapshots-rail-cta')`,
        ),
      { timeout: 8_000, intervals: [200, 400] },
    )
    .toBe(true)

  // The op card is gone after the auto-dismiss.
  expect(
    await popup.evaluate<boolean>(
      `!!document.querySelector('${byTestId(TID.snapshotsOpCard)}')`,
    ),
  ).toBe(false)
})
