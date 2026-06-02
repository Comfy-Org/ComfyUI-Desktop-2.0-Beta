// @vitest-environment node
/**
 * Integration test: standalone source `migrate-from` handler.
 *
 * No UI surface dispatches `migrate-from` directly today — the renderer
 * never builds an action entry for it. The handler is only reachable
 * programmatically through `handleReleaseUpdate`, which chains it after
 * the post-install bootstrap. That makes a full @lifecycle Playwright
 * test the wrong shape (no user click flow to validate) — but the merge
 * primitives the handler composes (`listCustomNodes`, `mergeDirFlat`,
 * `copyDirWithProgress`) are shared with the release-update path and
 * worth pinning at the handler boundary.
 *
 * Drives `handleAction('migrate-from', ...)` directly with a real
 * temporary filesystem source/destination pair. Electron, settings,
 * installations, i18n, pip, and envPaths are mocked so the test does
 * not need a real ComfyUI install on disk.
 *
 * Mirrors `updateOrchestrator.integration.test.ts` for the mock layout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { InstallationRecord } from '../../installations'

const SENTINEL_PYTHON = '__TEST_MASTER_PY__'
const SENTINEL_UV_NAME = '__sentinel_uv__'
const SENTINEL_ACTIVE_PY = '__TEST_ACTIVE_PY__'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../lib/i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

vi.mock('../../lib/snapshots', () => ({
  saveSnapshot: vi.fn(async () => 'noop.json'),
  getSnapshotCount: vi.fn(async () => 0),
}))

vi.mock('../../lib/bundledScript', () => ({
  getBundledScriptPath: (name: string) => `__BUNDLED__/${name}`,
}))

vi.mock('./envPaths', () => ({
  getMasterPythonPath: () => SENTINEL_PYTHON,
  getUvPath: (p: string) => path.join(p, SENTINEL_UV_NAME),
  getActivePythonPath: () => SENTINEL_ACTIVE_PY,
  getVenvDir: (p: string) => path.join(p, 'ComfyUI', '.venv'),
  getVenvPythonPath: (p: string) =>
    path.join(p, 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
}))

vi.mock('../../lib/pip', () => ({
  installFilteredRequirements: vi.fn(async () => 0),
}))

// `installations.get(sourceId)` is the only entry point handleMigrateFrom
// uses on this module. State is reset per test via beforeEach.
const installationsStore: Record<string, InstallationRecord> = {}
vi.mock('../../installations', () => ({
  get: vi.fn(async (id: string) => installationsStore[id] ?? null),
}))

// Source / destination dirs are isolated per test, so `settings.get`
// for shared paths is never invoked when both shared toggles are off on
// the destination — but stub it anyway so any future drift surfaces
// the missing field instead of crashing.
vi.mock('../../settings', () => ({
  get: vi.fn(() => undefined),
  defaults: { modelsDirs: ['/unused-test-models-dir'], inputDir: '/unused-test-input-dir', outputDir: '/unused-test-output-dir' },
  getMirrorConfig: vi.fn(() => ({ pypiMirror: undefined, useChineseMirrors: false })),
}))

// Import the SUT after all mocks are declared.
import { handleAction } from './actions'
import * as installationsModule from '../../installations'
import type { ActionTools } from '../../types/sources'

function makeInstallation(overrides: Partial<InstallationRecord> & { id: string; installPath: string }): InstallationRecord {
  return {
    name: overrides.id,
    sourceId: 'standalone',
    status: 'installed',
    createdAt: new Date(0).toISOString(),
    // Isolate models / input / output to per-install dirs for this test
    // (no shared injection from global settings).
    useSharedModels: false,
    useSharedInputOutput: false,
    ...overrides,
  } as InstallationRecord
}

function makeTools(): ActionTools {
  return {
    update: async () => {},
    sendProgress: () => {},
    sendOutput: () => {},
  }
}

const NODE_NAME = 'comfyui-test-node'
const NODE_FILE = 'node_entry.py'
const NODE_FILE_BODY = '# stub custom node module body — non-empty so mergeDirFlat copies it\n'
const WORKFLOW_FILE = 'wf-migrate-from.json'
const WORKFLOW_BODY = JSON.stringify({ nodes: [], links: [] }, null, 2)
const INPUT_FILE = 'sample-input.png'
const INPUT_BODY = 'binary-stub-input-bytes-not-actually-a-png\n'
const OUTPUT_FILE = 'sample-output.png'
const OUTPUT_BODY = 'binary-stub-output-bytes-not-actually-a-png\n'

function seedSource(srcRoot: string): void {
  const srcComfyUI = path.join(srcRoot, 'ComfyUI')
  fs.mkdirSync(path.join(srcComfyUI, 'custom_nodes', NODE_NAME), { recursive: true })
  fs.writeFileSync(path.join(srcComfyUI, 'custom_nodes', NODE_NAME, NODE_FILE), NODE_FILE_BODY)
  fs.mkdirSync(path.join(srcComfyUI, 'user', 'default', 'workflows'), { recursive: true })
  fs.writeFileSync(path.join(srcComfyUI, 'user', 'default', 'workflows', WORKFLOW_FILE), WORKFLOW_BODY)
  fs.mkdirSync(path.join(srcComfyUI, 'input'), { recursive: true })
  fs.writeFileSync(path.join(srcComfyUI, 'input', INPUT_FILE), INPUT_BODY)
  fs.mkdirSync(path.join(srcComfyUI, 'output'), { recursive: true })
  fs.writeFileSync(path.join(srcComfyUI, 'output', OUTPUT_FILE), OUTPUT_BODY)
}

describe('standalone handleAction(migrate-from)', () => {
  let tmpRoot: string
  let srcRoot: string
  let dstRoot: string
  let src: InstallationRecord
  let dst: InstallationRecord

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-migrate-from-'))
    srcRoot = path.join(tmpRoot, 'src')
    dstRoot = path.join(tmpRoot, 'dst')
    fs.mkdirSync(srcRoot, { recursive: true })
    fs.mkdirSync(path.join(dstRoot, 'ComfyUI'), { recursive: true })
    seedSource(srcRoot)
    src = makeInstallation({ id: 'src-1', installPath: srcRoot })
    dst = makeInstallation({ id: 'dst-1', installPath: dstRoot })
    installationsStore[src.id] = src
    installationsStore[dst.id] = dst
    // Make sure the mocked `installations.get` reflects the per-test store.
    vi.mocked(installationsModule.get).mockImplementation(async (id: string) => installationsStore[id] ?? null)
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    for (const k of Object.keys(installationsStore)) delete installationsStore[k]
  })

  it('copies customNodes + workflows + input + output into the destination ComfyUI dir', async () => {
    const tools = makeTools()
    const result = await handleAction(
      'migrate-from',
      dst,
      {
        sourceInstallationId: src.id,
        customNodes: true,
        workflows: true,
        input: true,
        output: true,
        models: false,
      },
      tools,
    )
    expect(result.ok, `migrate-from failed: ${result.message ?? ''}`).toBe(true)
    expect(result.navigate).toBe('detail')

    const dstComfyUI = path.join(dstRoot, 'ComfyUI')
    expect(fs.readFileSync(path.join(dstComfyUI, 'custom_nodes', NODE_NAME, NODE_FILE), 'utf-8'))
      .toBe(NODE_FILE_BODY)
    expect(fs.readFileSync(path.join(dstComfyUI, 'user', 'default', 'workflows', WORKFLOW_FILE), 'utf-8'))
      .toBe(WORKFLOW_BODY)
    expect(fs.readFileSync(path.join(dstComfyUI, 'input', INPUT_FILE), 'utf-8')).toBe(INPUT_BODY)
    expect(fs.readFileSync(path.join(dstComfyUI, 'output', OUTPUT_FILE), 'utf-8')).toBe(OUTPUT_BODY)
  })

  it('leaves the source install untouched', async () => {
    const tools = makeTools()
    await handleAction(
      'migrate-from',
      dst,
      { sourceInstallationId: src.id, customNodes: true, workflows: true, input: true, output: true, models: false },
      tools,
    )
    const srcComfyUI = path.join(srcRoot, 'ComfyUI')
    expect(fs.readFileSync(path.join(srcComfyUI, 'custom_nodes', NODE_NAME, NODE_FILE), 'utf-8'))
      .toBe(NODE_FILE_BODY)
    expect(fs.readFileSync(path.join(srcComfyUI, 'user', 'default', 'workflows', WORKFLOW_FILE), 'utf-8'))
      .toBe(WORKFLOW_BODY)
    expect(fs.readFileSync(path.join(srcComfyUI, 'input', INPUT_FILE), 'utf-8')).toBe(INPUT_BODY)
    expect(fs.readFileSync(path.join(srcComfyUI, 'output', OUTPUT_FILE), 'utf-8')).toBe(OUTPUT_BODY)
  })

  it('rejects when sourceInstallationId is missing', async () => {
    const result = await handleAction('migrate-from', dst, { customNodes: true }, makeTools())
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/source/i)
  })

  it('rejects when the source install id is unknown', async () => {
    const result = await handleAction(
      'migrate-from',
      dst,
      { sourceInstallationId: 'not-a-real-id', customNodes: true },
      makeTools(),
    )
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/source/i)
  })

  it('rejects when the source install has no ComfyUI directory', async () => {
    const orphanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-migrate-from-orphan-'))
    try {
      const orphan = makeInstallation({ id: 'orphan-1', installPath: orphanRoot })
      installationsStore[orphan.id] = orphan
      const result = await handleAction(
        'migrate-from',
        dst,
        { sourceInstallationId: orphan.id, customNodes: true },
        makeTools(),
      )
      expect(result.ok).toBe(false)
      // `findComfyUIDir` failure raises the localized `migrate.noComfyUIDir`
      // key — under the mocked i18n.t that's emitted verbatim.
      expect(result.message).toMatch(/noComfyUIDir/i)
    } finally {
      fs.rmSync(orphanRoot, { recursive: true, force: true })
    }
  })
})
