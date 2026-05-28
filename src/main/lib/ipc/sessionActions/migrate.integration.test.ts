// @vitest-environment node
/**
 * Integration test: `migrate-to-standalone` success path through
 * `handleMigrateToStandalone` for a legacy desktop source.
 *
 * A real Playwright @lifecycle exercise of this flow is infeasible — the
 * action downloads a multi-GB standalone archive and then bootstraps a
 * Python venv. We pin the handler boundary instead: stub `standalone.install`
 * + `standalone.postInstall` so the test stays fast, mock the snapshot
 * restore primitives, and let `copyMigrationData` run real against a
 * seeded source tree.
 *
 * Asserts the three properties Issue #591 cares about for this path:
 * - a new standalone installations entry is created with
 *   `copyReason: 'standalone-migration'` and the source lineage fields
 * - user / input / output files end up on the destination (under the
 *   new install's ComfyUI/ tree for user data; under the shared dirs
 *   returned by `settings.get` for input/output)
 * - the source install tree is untouched
 *
 * Closest reference: `copy.integration.test.ts` (release-update sibling).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { InstallationRecord } from '../../../installations'

// ── In-memory installations store, shared with the mocked module ──
const installationsStore = new Map<string, InstallationRecord>()
let idCounter = 0

// `detectDesktopInstall` is called unconditionally inside
// `performDesktopMigration` even when actionData.snapshotPath is supplied —
// the resolved basePath drives sourcePaths for user/input/output/models.
const desktopBasePathHolder = { value: '' }

// ── Mocks (must be declared before importing the SUT) ──

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (_name: string) => os.tmpdir(),
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}))

vi.mock('../../i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  init: vi.fn(async () => {}),
  getMessages: () => ({}),
  getLocale: () => 'en',
  getAvailableLocales: () => [],
}))

vi.mock('../../../settings', () => {
  const get = vi.fn((_key: string): unknown => undefined)
  const set = vi.fn(async () => {})
  return {
    get,
    set,
    getAll: vi.fn(() => ({})),
    getMirrorConfig: vi.fn(() => ({ pypiMirror: undefined, useChineseMirrors: false })),
    defaults: {
      modelsDirs: ['/unused-default-models'],
      inputDir: '/unused-default-input',
      outputDir: '/unused-default-output',
    },
  }
})

vi.mock('../../../installations', () => ({
  installationEvents: new EventEmitter(),
  list: vi.fn(async () => Array.from(installationsStore.values())),
  add: vi.fn(async (data: Record<string, unknown>) => {
    const id = `inst-${++idCounter}`
    const entry = { id, createdAt: new Date(0).toISOString(), ...data } as InstallationRecord
    installationsStore.set(id, entry)
    return entry
  }),
  get: vi.fn(async (id: string) => installationsStore.get(id) ?? null),
  update: vi.fn(async (id: string, data: Record<string, unknown>) => {
    const cur = installationsStore.get(id)
    if (!cur) return null
    const next = { ...cur, ...data } as InstallationRecord
    installationsStore.set(id, next)
    return next
  }),
  remove: vi.fn(async (id: string) => { installationsStore.delete(id) }),
  uniqueName: (baseName: string, _existing: InstallationRecord[]) => baseName,
}))

// Snapshot restore primitives are exercised real by
// `restoreSnapshotIntoInstallation` — stub them so no Python / git work runs.
vi.mock('../../snapshots', () => ({
  validateExportEnvelope: vi.fn((data: unknown) => data),
  importSnapshots: vi.fn(async () => {}),
  saveSnapshot: vi.fn(async () => 'noop.json'),
  getSnapshotCount: vi.fn(async () => 0),
  deduplicatePreUpdateSnapshot: vi.fn(async () => false),
  restoreCustomNodes: vi.fn(async () => {}),
  restorePipPackages: vi.fn(async () => {}),
  restoreComfyUIVersion: vi.fn(async () => ({ commit: null, ref: null, releaseTag: null, variant: null })),
  buildPostRestoreState: vi.fn(() => ({})),
  buildExportEnvelope: vi.fn((label: string, items: unknown[]) => ({
    version: 1, label, exportedAt: '2024-01-01T00:00:00Z', snapshots: items,
  })),
}))

vi.mock('../../desktopDetect', () => ({
  detectDesktopInstall: vi.fn(() => ({
    basePath: desktopBasePathHolder.value,
    configDir: '',
    logsDir: '',
  })),
  stageDesktopSnapshot: vi.fn(async () => ({ stagedFile: '', envelope: {} })),
  assertReadable: vi.fn(() => {}),
  captureDesktopSnapshot: vi.fn(async () => ({})),
  findDesktopExecutable: vi.fn(() => null),
  pipFreezeDirect: vi.fn(async () => ({})),
}))

vi.mock('../../../lib/pip', () => ({
  installFilteredRequirements: vi.fn(async () => 0),
}))

// ── Import the SUT and the source plugin we monkey-patch ──
import { handleMigrateToStandalone } from './migrate'
import { standalone } from '../../../sources/standalone'
import * as settingsMock from '../../../settings'

function makeSender(): Electron.WebContents {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as Electron.WebContents
}

const USER_FILE = 'user-config.json'
const USER_BODY = '{"setting": "value"}\n'
const INPUT_FILE = 'sample-input.png'
const INPUT_BODY = 'binary-stub-input-bytes\n'
const OUTPUT_FILE = 'sample-output.png'
const OUTPUT_BODY = 'binary-stub-output-bytes\n'
const MODEL_FILE = 'sample.safetensors'
const MODEL_BODY = 'binary-stub-model-bytes\n'

function seedDesktopSource(basePath: string): void {
  // Legacy desktop tree — user/input/output/models live directly under basePath,
  // matching how `performDesktopMigration` resolves sourcePaths against
  // `desktopInfo.basePath`.
  fs.mkdirSync(path.join(basePath, 'user'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'user', USER_FILE), USER_BODY)
  fs.mkdirSync(path.join(basePath, 'input'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'input', INPUT_FILE), INPUT_BODY)
  fs.mkdirSync(path.join(basePath, 'output'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'output', OUTPUT_FILE), OUTPUT_BODY)
  fs.mkdirSync(path.join(basePath, 'models', 'checkpoints'), { recursive: true })
  fs.writeFileSync(path.join(basePath, 'models', 'checkpoints', MODEL_FILE), MODEL_BODY)
}

function writeStagedSnapshot(filePath: string): void {
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    label: 'Legacy Desktop Migration',
    exportedAt: '2024-01-01T00:00:00Z',
    snapshots: [{
      version: 1,
      createdAt: '2024-01-01T00:00:00Z',
      trigger: 'manual',
      label: 'desktop',
      comfyui: { ref: 'Legacy Desktop', commit: null, releaseTag: '', variant: '' },
      customNodes: [],
      pipPackages: {},
      skipPipSync: true,
    }],
  }, null, 2))
}

describe('handleMigrateToStandalone (desktop migration success path)', () => {
  let tmpRoot: string
  let desktopBase: string
  let stagedFile: string
  let sharedModelsDir: string
  let sharedInputDir: string
  let sharedOutputDir: string
  let createdInstallPaths: string[]
  let src: InstallationRecord
  const originalInstall = standalone.install
  const originalPostInstall = standalone.postInstall

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-standalone-'))
    desktopBase = path.join(tmpRoot, 'legacy-desktop')
    fs.mkdirSync(desktopBase, { recursive: true })
    seedDesktopSource(desktopBase)
    desktopBasePathHolder.value = desktopBase

    stagedFile = path.join(tmpRoot, 'staged-snapshot.json')
    writeStagedSnapshot(stagedFile)

    sharedModelsDir = path.join(tmpRoot, 'shared-models')
    sharedInputDir = path.join(tmpRoot, 'shared-input')
    sharedOutputDir = path.join(tmpRoot, 'shared-output')
    fs.mkdirSync(sharedModelsDir, { recursive: true })
    fs.mkdirSync(sharedInputDir, { recursive: true })
    fs.mkdirSync(sharedOutputDir, { recursive: true })
    vi.mocked(settingsMock.get).mockImplementation((key: string): unknown => {
      if (key === 'modelsDirs') return [sharedModelsDir]
      if (key === 'inputDir') return sharedInputDir
      if (key === 'outputDir') return sharedOutputDir
      return undefined
    })

    src = {
      id: 'src-1',
      name: 'Legacy Desktop',
      sourceId: 'desktop',
      installPath: desktopBase,
      status: 'installed',
      createdAt: new Date(0).toISOString(),
    }
    installationsStore.set(src.id, src)

    // No real download/extract or python bootstrap. The destination directory
    // is created by `migrateToStandaloneFromSnapshot` itself before invoking
    // install; `copyMigrationData` then materializes the inner ComfyUI subtree.
    standalone.install = (async () => {}) as typeof standalone.install
    standalone.postInstall = (async () => {}) as typeof standalone.postInstall

    createdInstallPaths = []
  })

  afterEach(() => {
    standalone.install = originalInstall
    standalone.postInstall = originalPostInstall
    installationsStore.clear()
    for (const p of createdInstallPaths) {
      try { fs.rmSync(p, { recursive: true, force: true }) } catch {}
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('creates a standalone-migration entry and copies user/input/output from the desktop source', async () => {
    const sender = makeSender()
    const event = { sender } as unknown as Electron.IpcMainInvokeEvent

    const result = await handleMigrateToStandalone({
      event,
      installationId: src.id,
      inst: src,
      actionData: {
        snapshotPath: stagedFile,
        enablePipSync: false,
        target: {
          mode: 'selected',
          release: { value: 'v1.0.0', label: 'v1.0.0' },
          variant: {
            value: 'cuda',
            label: 'CUDA',
            data: {
              variantId: 'cuda',
              manifest: { id: 'cuda', comfyui_ref: 'v0.3.0', python_version: '3.12.4' },
              downloadFiles: [],
              downloadUrl: '',
              r2Release: {
                tag: 'v1.0.0',
                comfyui_version: '0.3.0',
                comfyui_commit: 'abc',
                build: 1,
                date: '2024-01-01',
                file: 'x.zip',
                size: 1,
                python_version: '3.12.4',
                torch_version: '2.0.0',
              },
            },
          },
        },
      },
    })

    expect(result.ok, `migrate-to-standalone failed: ${result.message ?? ''}`).toBe(true)
    expect(result.navigate).toBe('list')

    // The only installation added (besides `src`) is the freshly created standalone.
    const created = Array.from(installationsStore.values()).find((i) => i.id !== src.id)
    expect(created).toBeTruthy()
    createdInstallPaths.push(created!.installPath)

    expect(created!.sourceId).toBe('standalone')
    expect(created!.copyReason).toBe('standalone-migration')
    expect(created!.copiedFrom).toBe(src.id)
    expect(created!.copiedFromName).toBe(src.name)
    expect(typeof created!.copiedAt).toBe('string')
    expect(created!.status).toBe('installed')

    // User data lands under the new install's own ComfyUI/user tree.
    const dstComfyUI = path.join(created!.installPath, 'ComfyUI')
    expect(fs.readFileSync(path.join(dstComfyUI, 'user', USER_FILE), 'utf-8')).toBe(USER_BODY)

    // Input / output route through the settings-provided shared dirs.
    expect(fs.readFileSync(path.join(sharedInputDir, INPUT_FILE), 'utf-8')).toBe(INPUT_BODY)
    expect(fs.readFileSync(path.join(sharedOutputDir, OUTPUT_FILE), 'utf-8')).toBe(OUTPUT_BODY)

    // Models — left in place; the desktop models dir is appended to the shared
    // modelsDirs list rather than copied.
    expect(fs.readFileSync(path.join(desktopBase, 'models', 'checkpoints', MODEL_FILE), 'utf-8')).toBe(MODEL_BODY)
    expect(vi.mocked(settingsMock.set)).toHaveBeenCalledWith(
      'modelsDirs',
      expect.arrayContaining([path.resolve(path.join(desktopBase, 'models'))]),
    )

    // Source install untouched.
    expect(fs.readFileSync(path.join(desktopBase, 'user', USER_FILE), 'utf-8')).toBe(USER_BODY)
    expect(fs.readFileSync(path.join(desktopBase, 'input', INPUT_FILE), 'utf-8')).toBe(INPUT_BODY)
    expect(fs.readFileSync(path.join(desktopBase, 'output', OUTPUT_FILE), 'utf-8')).toBe(OUTPUT_BODY)
  })
})
