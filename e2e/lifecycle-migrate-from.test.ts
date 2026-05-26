/**
 * Lifecycle E2E: standalone `migrate-from` action invoked directly.
 *
 * `release-update` chains `runAction('migrate-from', ...)` after the
 * post-install bootstrap to copy customNodes / workflows / models /
 * input / output across to the freshly installed release. There is no
 * UI surface that fires `migrate-from` on its own today, but the action
 * handler is reachable via the `run-action` IPC for any source-targeted
 * action and the merge primitives it composes (`listCustomNodes`,
 * `mergeDirFlat`, `copyDirWithProgress`) are shared with that wrapper.
 *
 * Drives the IPC directly with a source standalone install populated
 * with the four destinations migrate-from cares about (custom_nodes,
 * workflows, input, output) and asserts the destination dir ends up
 * with the expected files while the source is left untouched.
 * (audit lifecycle #6)
 */

import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { launchApp, type AppContext } from './launchApp'
import { expectChooserVisible } from './support/chooserHelpers'

let ctx: AppContext
let srcRoot: string
let dstRoot: string

const SRC_ID = 'inst-migrate-from-src'
const SRC_NAME = 'Migrate From Source'
const DST_ID = 'inst-migrate-from-dst'
const DST_NAME = 'Migrate From Destination'

/** Mirrors `MARKER_FILE` in `src/main/lib/ipc/shared.ts`. The destination
 *  needs the marker (id-matching) because some adjacent lifecycle code
 *  checks for it; the source does not strictly need one for migrate-from
 *  but we add it for parity with how the launcher seeds real installs. */
const MARKER_FILENAME = '.comfyui-desktop-2'

const NODE_NAME = 'comfyui-test-node'
const NODE_FILE = 'node_entry.py'
const NODE_FILE_BODY = '# stub custom node module body — non-empty so mergeDirFlat copies it\n'

const WORKFLOW_FILE = 'wf-migrate-from.json'
const WORKFLOW_BODY = JSON.stringify({ nodes: [], links: [] }, null, 2)

const INPUT_FILE = 'sample-input.png'
const INPUT_BODY = 'binary-stub-input-bytes-not-actually-a-png\n'

const OUTPUT_FILE = 'sample-output.png'
const OUTPUT_BODY = 'binary-stub-output-bytes-not-actually-a-png\n'

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true } catch { return false }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  srcRoot = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-migrate-from-src-'))
  dstRoot = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-migrate-from-dst-'))

  // Source layout: findComfyUIDir picks up <installPath>/ComfyUI directly.
  // Populate the four migrate-from-targeted subtrees plus a custom node
  // without a requirements.txt (so the deps phase exits via the
  // `nodesWithReqs.length === 0` short-circuit and no uv invocation is
  // attempted — there is no real Python env in the harness).
  const srcComfyUI = path.join(srcRoot, 'ComfyUI')
  await mkdir(path.join(srcComfyUI, 'custom_nodes', NODE_NAME), { recursive: true })
  await writeFile(path.join(srcComfyUI, 'custom_nodes', NODE_NAME, NODE_FILE), NODE_FILE_BODY)
  await mkdir(path.join(srcComfyUI, 'user', 'default', 'workflows'), { recursive: true })
  await writeFile(path.join(srcComfyUI, 'user', 'default', 'workflows', WORKFLOW_FILE), WORKFLOW_BODY)
  await mkdir(path.join(srcComfyUI, 'input'), { recursive: true })
  await writeFile(path.join(srcComfyUI, 'input', INPUT_FILE), INPUT_BODY)
  await mkdir(path.join(srcComfyUI, 'output'), { recursive: true })
  await writeFile(path.join(srcComfyUI, 'output', OUTPUT_FILE), OUTPUT_BODY)
  await writeFile(path.join(srcRoot, MARKER_FILENAME), SRC_ID)

  // Destination only needs the bare ComfyUI/ directory — handleMigrateFrom
  // creates custom_nodes/, user/, input/, output/ subdirs as needed.
  await mkdir(path.join(dstRoot, 'ComfyUI'), { recursive: true })
  await writeFile(path.join(dstRoot, MARKER_FILENAME), DST_ID)

  ctx = await launchApp({
    settings: { firstUseCompleted: true, telemetryEnabled: false },
    installations: [
      {
        id: SRC_ID,
        name: SRC_NAME,
        installPath: srcRoot,
        sourceId: 'standalone',
        status: 'installed',
      },
      {
        id: DST_ID,
        name: DST_NAME,
        installPath: dstRoot,
        sourceId: 'standalone',
        status: 'installed',
        // Force isolated per-install dirs so migrate-from writes into
        // <dstRoot>/ComfyUI/{input,output,models} instead of the global
        // shared dirs the harness creates under the test home.
        useSharedPaths: false,
      },
    ],
  })
  await expectChooserVisible(ctx.panel)
})

test.afterAll(async () => {
  await ctx?.cleanup()
  if (srcRoot) await rm(srcRoot, { recursive: true, force: true })
  if (dstRoot) await rm(dstRoot, { recursive: true, force: true })
})

test('migrate-from copies customNodes + workflows + input + output into the destination ComfyUI dir @lifecycle', async () => {
  const result = await ctx.panel.evaluate<{ ok: boolean; message?: string; navigate?: string }>(
    `window.api.runAction(${JSON.stringify(DST_ID)}, 'migrate-from', ${JSON.stringify({
      sourceInstallationId: SRC_ID,
      customNodes: true,
      workflows: true,
      input: true,
      output: true,
      // Leave models off — needs the shared models dir setting wired
      // and is covered indirectly by the release-update integration in
      // the standalone install lifecycle.
      models: false,
    })})`,
  )
  expect(result.ok, `migrate-from failed: ${result.message ?? ''}`).toBe(true)
  expect(result.navigate, 'migrate-from should request a navigate back to detail').toBe('detail')

  const dstComfyUI = path.join(dstRoot, 'ComfyUI')
  const copiedNode = path.join(dstComfyUI, 'custom_nodes', NODE_NAME, NODE_FILE)
  const copiedWorkflow = path.join(dstComfyUI, 'user', 'default', 'workflows', WORKFLOW_FILE)
  const copiedInput = path.join(dstComfyUI, 'input', INPUT_FILE)
  const copiedOutput = path.join(dstComfyUI, 'output', OUTPUT_FILE)

  expect(await pathExists(copiedNode), 'custom node file missing in destination').toBe(true)
  expect(await pathExists(copiedWorkflow), 'workflow JSON missing in destination').toBe(true)
  expect(await pathExists(copiedInput), 'input file missing in destination').toBe(true)
  expect(await pathExists(copiedOutput), 'output file missing in destination').toBe(true)

  // Content survives the copy verbatim — guards against mergeDirFlat /
  // copyDirWithProgress regressions that might truncate or skip files.
  expect(await readFile(copiedNode, 'utf-8')).toBe(NODE_FILE_BODY)
  expect(await readFile(copiedWorkflow, 'utf-8')).toBe(WORKFLOW_BODY)
  expect(await readFile(copiedInput, 'utf-8')).toBe(INPUT_BODY)
  expect(await readFile(copiedOutput, 'utf-8')).toBe(OUTPUT_BODY)
})

test('migrate-from leaves the source install untouched @lifecycle', async () => {
  const srcComfyUI = path.join(srcRoot, 'ComfyUI')
  expect(await readFile(path.join(srcComfyUI, 'custom_nodes', NODE_NAME, NODE_FILE), 'utf-8'))
    .toBe(NODE_FILE_BODY)
  expect(await readFile(path.join(srcComfyUI, 'user', 'default', 'workflows', WORKFLOW_FILE), 'utf-8'))
    .toBe(WORKFLOW_BODY)
  expect(await readFile(path.join(srcComfyUI, 'input', INPUT_FILE), 'utf-8')).toBe(INPUT_BODY)
  expect(await readFile(path.join(srcComfyUI, 'output', OUTPUT_FILE), 'utf-8')).toBe(OUTPUT_BODY)
})

test('migrate-from with an unknown source id returns ok:false @lifecycle', async () => {
  const result = await ctx.panel.evaluate<{ ok: boolean; message?: string }>(
    `window.api.runAction(${JSON.stringify(DST_ID)}, 'migrate-from', ${JSON.stringify({
      sourceInstallationId: 'inst-does-not-exist',
      customNodes: true,
    })})`,
  )
  expect(result.ok, 'migrate-from with missing source must reject').toBe(false)
  expect(result.message, 'rejection message must mention the missing source').toMatch(/source/i)
})

test('migrate-from without a sourceInstallationId returns ok:false @lifecycle', async () => {
  const result = await ctx.panel.evaluate<{ ok: boolean; message?: string }>(
    `window.api.runAction(${JSON.stringify(DST_ID)}, 'migrate-from', ${JSON.stringify({
      customNodes: true,
    })})`,
  )
  expect(result.ok, 'migrate-from without source id must reject').toBe(false)
  expect(result.message, 'rejection message must mention the missing source').toMatch(/source/i)
})
