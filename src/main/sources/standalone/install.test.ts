// @vitest-environment node
/**
 * Unit tests for postInstall's snapshot-trigger decision.
 *
 * Regression guard for #707: a fresh "Latest Stable" install auto-updates the
 * just-extracted bundled ComfyUI to the newest release, which writes its own
 * `post-update` snapshot. Capturing a `boot` snapshot *before* that update
 * recorded the bundled version (e.g. v0.20.x), leaving the snapshot history
 * showing a phantom "upgrade" (bundled → latest) the user never performed.
 *
 * postInstall should therefore:
 *  - skip the boot snapshot when an auto-update will run and succeed (the
 *    post-update snapshot is the single baseline), and
 *  - still capture a boot snapshot when no auto-update runs, or when the
 *    auto-update is skipped/fails (so there is always a "Current" baseline).
 *
 * Heavy collaborators (uv/venv subprocess, package copy, git, version
 * resolution, the update orchestrator, mac binary repair) are mocked so the
 * test exercises only the snapshot decision logic.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { InstallationRecord } from '../../installations'
import type { PostInstallTools } from '../../types/sources'

const SENTINEL_PYTHON = '__TEST_MASTER_PY__'
const SENTINEL_UV_NAME = '__sentinel_uv__'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../lib/i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const saveSnapshot = vi.fn(async (_installPath: string, _installation: unknown, trigger: string) => `${trigger}-snap.json`)
vi.mock('../../lib/snapshots', () => ({
  saveSnapshot: (...args: unknown[]) => (saveSnapshot as unknown as (...a: unknown[]) => unknown)(...args),
  getSnapshotCount: vi.fn(async () => 1),
}))

vi.mock('../../lib/copy', () => ({
  copyDirWithProgress: vi.fn(async () => {}),
}))

vi.mock('../../lib/installer', () => ({
  downloadAndExtract: vi.fn(async () => {}),
  downloadAndExtractMulti: vi.fn(async () => {}),
}))

vi.mock('../../lib/git', () => ({
  readGitHead: vi.fn(() => 'abc1234abc1234abc1234abc1234abc1234abcd'),
  isGitAvailable: vi.fn(async () => true),
  isPygit2Configured: vi.fn(() => true),
  tryConfigurePygit2Fallback: vi.fn(),
  fetchTags: vi.fn(async () => {}),
}))

vi.mock('../../lib/version-resolve', () => ({
  resolveLocalVersion: vi.fn(async () => ({ commit: 'abc1234', baseTag: 'v0.20.0', commitsAhead: 0 })),
}))

const fetchLatestRelease = vi.fn(async () => ({ tag_name: 'v0.22.3' }))
vi.mock('../../lib/comfyui-releases', () => ({
  fetchLatestRelease: (...args: unknown[]) => (fetchLatestRelease as unknown as (...a: unknown[]) => unknown)(...args),
}))

vi.mock('./macRepair', () => ({
  repairMacBinaries: vi.fn(async () => {}),
  codesignBinaries: vi.fn(async () => {}),
}))

const runComfyUIUpdate = vi.fn(async (opts: { installation: InstallationRecord }) => ({
  ok: true,
  installation: opts.installation,
}))
vi.mock('./updateOrchestrator', () => ({
  runComfyUIUpdate: (...args: unknown[]) => (runComfyUIUpdate as unknown as (...a: unknown[]) => unknown)(...args),
}))

vi.mock('./envPaths', () => ({
  MANIFEST_FILE: 'manifest.json',
  DEFAULT_LAUNCH_ARGS: '',
  getUvPath: (p: string) => path.join(p, SENTINEL_UV_NAME),
  getVenvDir: (p: string) => path.join(p, 'ComfyUI', '.venv'),
  getMasterPythonPath: () => SENTINEL_PYTHON,
  // Return a real, existing directory so createEnv's existsSync/copy path is satisfied.
  findSitePackages: () => sitePackagesDir,
  writeComfyEnvironment: vi.fn(async () => {}),
}))

// Mock child_process.execFile so createEnv's `uv venv` resolves immediately.
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    setImmediate(() => cb(null, '', ''))
    const proc = new EventEmitter() as EventEmitter & { kill: () => void }
    proc.kill = () => {}
    return proc
  },
}))

// Shared dir referenced by the envPaths mock (set per-test in beforeEach).
let sitePackagesDir = ''

// Import SUT after mocks.
import { postInstall } from './install'

function makeInstallation(overrides: Partial<InstallationRecord> & { installPath: string }): InstallationRecord {
  return {
    id: 'test-install',
    name: 'Test',
    sourceId: 'standalone',
    status: 'installed',
    createdAt: new Date(0).toISOString(),
    version: 'v0.20.0',
    ...overrides,
  } as InstallationRecord
}

function makeTools(installation: InstallationRecord): PostInstallTools {
  return {
    sendProgress: vi.fn(),
    update: vi.fn(async (data: Record<string, unknown>) => {
      Object.assign(installation, data)
    }),
  } as unknown as PostInstallTools
}

describe('postInstall snapshot trigger (#707)', () => {
  let tmpDir: string

  beforeEach(() => {
    saveSnapshot.mockClear()
    runComfyUIUpdate.mockClear()
    fetchLatestRelease.mockClear()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-'))
    // Lay out the dirs createEnv / postInstall touch.
    fs.mkdirSync(path.join(tmpDir, 'ComfyUI', '.git'), { recursive: true })
    sitePackagesDir = path.join(tmpDir, 'standalone-env', 'site-packages')
    fs.mkdirSync(sitePackagesDir, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'ComfyUI', '.venv'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, SENTINEL_UV_NAME), '')
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it('does NOT capture a boot snapshot when a successful auto-update will run', async () => {
    const installation = makeInstallation({ installPath: tmpDir, autoUpdateComfyUI: true })
    await postInstall(installation, makeTools(installation))

    expect(runComfyUIUpdate).toHaveBeenCalledTimes(1)
    // The only snapshot is the orchestrator's post-update one — no boot snapshot here.
    const triggers = saveSnapshot.mock.calls.map((c) => c[2])
    expect(triggers).not.toContain('boot')
  })

  it('captures a boot snapshot when no auto-update runs (pinned release)', async () => {
    const installation = makeInstallation({ installPath: tmpDir })
    await postInstall(installation, makeTools(installation))

    expect(runComfyUIUpdate).not.toHaveBeenCalled()
    const triggers = saveSnapshot.mock.calls.map((c) => c[2])
    expect(triggers).toEqual(['boot'])
  })

  it('falls back to a boot snapshot when auto-update is skipped (latest unverifiable)', async () => {
    fetchLatestRelease.mockResolvedValueOnce(null as unknown as { tag_name: string })
    const installation = makeInstallation({ installPath: tmpDir, autoUpdateComfyUI: true })
    await postInstall(installation, makeTools(installation))

    expect(runComfyUIUpdate).not.toHaveBeenCalled()
    const triggers = saveSnapshot.mock.calls.map((c) => c[2])
    expect(triggers).toEqual(['boot'])
  })

  it('falls back to a boot snapshot when the auto-update fails', async () => {
    runComfyUIUpdate.mockResolvedValueOnce({ ok: false, installation: makeInstallation({ installPath: tmpDir }) })
    const installation = makeInstallation({ installPath: tmpDir, autoUpdateComfyUI: true })
    await postInstall(installation, makeTools(installation))

    expect(runComfyUIUpdate).toHaveBeenCalledTimes(1)
    const triggers = saveSnapshot.mock.calls.map((c) => c[2])
    expect(triggers).toEqual(['boot'])
  })
})
