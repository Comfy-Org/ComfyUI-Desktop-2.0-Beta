// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import type { Readable } from 'stream'
import type * as ChildProcessModule from 'child_process'

// ---------------------------------------------------------------------------
// Sentinel commands returned by the mocked envPaths — used to identify
// Python/uv subprocesses in the spawn interceptor below.
// ---------------------------------------------------------------------------
const SENTINEL_PYTHON = '__TEST_MASTER_PY__'
const SENTINEL_UV_NAME = '__sentinel_uv__'
const SENTINEL_ACTIVE_PY = '__TEST_ACTIVE_PY__'

// ---------------------------------------------------------------------------
// State shared between the hoisted mock and the test body.  vi.hoisted()
// ensures the object exists before any vi.mock factory runs.
// ---------------------------------------------------------------------------
const spawnState = vi.hoisted(() => ({
  pythonHandler: undefined as undefined | ((args: string[]) => ChildProcess),
  uvHandler: undefined as undefined | ((args: string[]) => ChildProcess),
  uvCalls: [] as string[][],
}))

// ---------------------------------------------------------------------------
// Mock electron — required by bundledScript, settings, paths
// ---------------------------------------------------------------------------
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

// ---------------------------------------------------------------------------
// Mock snapshots — already has its own unit tests; avoid pulling in
// scanCustomNodes / pipFreeze / filesystem assumptions.
// ---------------------------------------------------------------------------
vi.mock('../../lib/snapshots', () => ({
  saveSnapshot: vi.fn(async (_installPath: string, _installation: unknown, trigger: string) =>
    `${trigger}-snap.json`
  ),
  getSnapshotCount: vi.fn(async () => 1),
  deduplicatePreUpdateSnapshot: vi.fn(async () => false),
}))

// ---------------------------------------------------------------------------
// Mock envPaths — return sentinel command strings so we can intercept them
// in the spawn mock without needing real Python/uv binaries.
// ---------------------------------------------------------------------------
vi.mock('./envPaths', () => ({
  getMasterPythonPath: () => SENTINEL_PYTHON,
  getUvPath: (p: string) => path.join(p, SENTINEL_UV_NAME),
  getActivePythonPath: () => SENTINEL_ACTIVE_PY,
  getVenvDir: (p: string) => path.join(p, 'ComfyUI', '.venv'),
  getVenvPythonPath: (p: string) => path.join(p, 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
}))

// ---------------------------------------------------------------------------
// Mock settings — avoid reading real settings.json from disk.
// ---------------------------------------------------------------------------
vi.mock('../../settings', () => ({
  get: vi.fn((key: string) => {
    if (key === 'pypiMirror') return undefined
    if (key === 'useChineseMirrors') return false
    return undefined
  }),
  getMirrorConfig: vi.fn(() => ({ pypiMirror: undefined, useChineseMirrors: false })),
}))

// ---------------------------------------------------------------------------
// Mock bundledScript — return a placeholder path instead of relying on
// __dirname / electron app layout.
// ---------------------------------------------------------------------------
vi.mock('../../lib/bundledScript', () => ({
  getBundledScriptPath: (name: string) => `__BUNDLED__/${name}`,
}))

// ---------------------------------------------------------------------------
// Mock macRepair — never actually runs on Windows/Linux CI.
// ---------------------------------------------------------------------------
vi.mock('./macRepair', () => ({
  repairMacBinaries: vi.fn(async () => {}),
}))

// ---------------------------------------------------------------------------
// Mock i18n — return the key itself so assertions don't depend on locale files.
// ---------------------------------------------------------------------------
vi.mock('../../lib/i18n', () => ({
  t: (key: string, params?: Record<string, unknown>) => {
    if (params) return `${key}:${JSON.stringify(params)}`
    return key
  },
}))

// ---------------------------------------------------------------------------
// Selective child_process.spawn mock: intercept only Python/uv sentinel
// commands; delegate everything else (git, etc.) to the real implementation.
// ---------------------------------------------------------------------------
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return {
    ...actual,
    spawn: vi.fn((command: string, args?: readonly string[], options?: object) => {
      if (command === SENTINEL_PYTHON && spawnState.pythonHandler) {
        return spawnState.pythonHandler([...(args ?? [])])
      }
      if (typeof command === 'string' && command.endsWith(SENTINEL_UV_NAME) && spawnState.uvHandler) {
        spawnState.uvCalls.push([...(args ?? [])])
        return spawnState.uvHandler([...(args ?? [])])
      }
      return actual.spawn(command, args as string[], options as Parameters<typeof actual.spawn>[2])
    }),
  }
})

// ---------------------------------------------------------------------------
// Import the SUT *after* all vi.mock declarations.
// ---------------------------------------------------------------------------
import { runComfyUIUpdate } from './updateOrchestrator'
import type { UpdateOrchestrationOptions } from './updateOrchestrator'
import { clearVersionCache } from '../../lib/version-resolve'
import { formatComfyVersion } from '../../lib/version'
import type { InstallationRecord } from '../../installations'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Create a readable stream that emits given chunks then ends. */
function makeReadable(chunks: string[]): Readable {
  const readable = new EventEmitter() as Readable
  // Prevent "no listeners" warnings — spawnUpdateScript attaches .on('data')
  readable.destroy = vi.fn() as Readable['destroy']
  process.nextTick(() => {
    for (const chunk of chunks) {
      readable.emit('data', Buffer.from(chunk))
    }
  })
  return readable
}

/** Build a fake ChildProcess that emits the given stdout/stderr and exits. */
function fakeProc(opts: {
  stdout?: string[]
  stderr?: string[]
  exitCode?: number
  exitSignal?: string | null
}): ChildProcess {
  // Use a plain object cast to ChildProcess to avoid TS2540 on readonly props
  const proc = new EventEmitter() as ChildProcess & { pid: number; killed: boolean }
  const exitCode = opts.exitCode ?? 0
  proc.stdout = makeReadable(opts.stdout ?? [])
  proc.stderr = makeReadable(opts.stderr ?? [])
  proc.pid = 99999
  proc.killed = false
  proc.kill = vi.fn(() => {
    proc.killed = true
    proc.emit('close', 1, 'SIGTERM')
    return true
  })
  // Emit 'close' after stdout/stderr have been consumed.
  // Guard against double-emit if kill() was called first.
  process.nextTick(() => {
    process.nextTick(() => {
      if (!proc.killed) {
        proc.emit('close', exitCode, opts.exitSignal ?? null)
      }
    })
  })
  return proc
}

interface TestRepoShas {
  v1Sha: string
  v2Sha: string
  /** Commits beyond the latest tag (for latest-channel tests). */
  aheadShas: string[]
}

/** Create a minimal git repo with tagged commits and a requirements file. */
function createTestRepo(installPath: string, commitsAheadOfTag: number = 0): TestRepoShas {
  const comfyuiDir = path.join(installPath, 'ComfyUI')
  fs.mkdirSync(comfyuiDir, { recursive: true })

  const gitOpts = { cwd: comfyuiDir, windowsHide: true, stdio: 'pipe' as const }
  execFileSync('git', ['init'], gitOpts)
  execFileSync('git', ['config', 'user.email', 'test@test.com'], gitOpts)
  execFileSync('git', ['config', 'user.name', 'Test'], gitOpts)

  // First commit + tag v0.1.0
  fs.writeFileSync(path.join(comfyuiDir, 'requirements.txt'), 'torch==2.0\nfoo==1.0\n')
  execFileSync('git', ['add', '.'], gitOpts)
  execFileSync('git', ['commit', '-m', 'initial'], gitOpts)
  execFileSync('git', ['tag', 'v0.1.0'], gitOpts)
  const v1Sha = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim()

  // Second commit + tag v0.2.0 — changed requirements
  fs.writeFileSync(path.join(comfyuiDir, 'requirements.txt'), 'torch==2.0\nfoo==2.0\nbar==1.0\n')
  fs.writeFileSync(path.join(comfyuiDir, 'manager_requirements.txt'), 'baz==1.0\n')
  execFileSync('git', ['add', '.'], gitOpts)
  execFileSync('git', ['commit', '-m', 'bump deps'], gitOpts)
  execFileSync('git', ['tag', 'v0.2.0'], gitOpts)
  const v2Sha = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim()

  // Optional commits beyond v0.2.0 (untagged, simulating "latest" channel)
  const aheadShas: string[] = []
  for (let i = 1; i <= commitsAheadOfTag; i++) {
    fs.writeFileSync(path.join(comfyuiDir, `feature-${i}.txt`), `feature ${i}\n`)
    execFileSync('git', ['add', '.'], gitOpts)
    execFileSync('git', ['commit', '-m', `feature ${i}`], gitOpts)
    aheadShas.push(execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).toString().trim())
  }

  // Point HEAD back to v0.1.0 (pre-update state)
  execFileSync('git', ['checkout', 'v0.1.0', '--detach'], gitOpts)

  return { v1Sha, v2Sha, aheadShas }
}

/** Build a fake Python update script handler that "moves" the repo to v0.2.0. */
function makeSuccessfulUpdateHandler(
  comfyuiDir: string,
  v2Sha: string,
): (args: string[]) => ChildProcess {
  return (_args: string[]) => {
    // Simulate what update_comfyui.py does: checkout the new version
    execFileSync('git', ['checkout', 'v0.2.0', '--detach'], {
      cwd: comfyuiDir,
      windowsHide: true,
      stdio: 'pipe',
    })

    return fakeProc({
      stdout: [
        `[PRE_UPDATE_HEAD] ${execFileSync('git', ['rev-parse', 'v0.1.0'], { cwd: comfyuiDir, windowsHide: true, stdio: 'pipe' }).toString().trim()}\n`,
        `[POST_UPDATE_HEAD] ${v2Sha}\n`,
        `[CHECKED_OUT_TAG] v0.2.0\n`,
        `[BACKUP_BRANCH] backup-pre-update\n`,
      ],
      exitCode: 0,
    })
  }
}

function makeBaseOpts(
  installPath: string,
  overrides?: Partial<UpdateOrchestrationOptions>,
): UpdateOrchestrationOptions {
  const installation: InstallationRecord = {
    id: 'test-install',
    name: 'Test Installation',
    createdAt: new Date().toISOString(),
    installPath,
    sourceId: 'standalone',
    status: 'installed',
  }
  const updateCalls: Record<string, unknown>[] = []
  const progressCalls: { step: string; data: Record<string, unknown> }[] = []
  const outputChunks: string[] = []

  return {
    installPath,
    installation,
    channel: 'stable',
    update: vi.fn(async (data: Record<string, unknown>) => { updateCalls.push(data) }),
    sendProgress: vi.fn((step: string, data: Record<string, unknown>) => { progressCalls.push({ step, data }) }),
    sendOutput: vi.fn((text: string) => { outputChunks.push(text) }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const HAS_GIT = isGitAvailable()

describe.skipIf(!HAS_GIT)('runComfyUIUpdate integration', () => {
  let tmpDir: string
  let installPath: string
  let comfyuiDir: string
  let repoShas: { v1Sha: string; v2Sha: string }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-orch-'))
    installPath = tmpDir
    comfyuiDir = path.join(installPath, 'ComfyUI')
    repoShas = createTestRepo(installPath)

    // Reset spawn state
    spawnState.pythonHandler = undefined
    spawnState.uvHandler = undefined
    spawnState.uvCalls = []

    // Create sentinel uv file inside tmpDir so fs.existsSync(getUvPath(...)) passes
    fs.writeFileSync(path.join(installPath, SENTINEL_UV_NAME), '')

    // Clear version-resolve cache between tests
    clearVersionCache()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // -----------------------------------------------------------------------
  // 1. PyTorch filtering — real PYTORCH_RE regex on real file content
  // -----------------------------------------------------------------------
  describe('PyTorch filtering', () => {
    it('excludes PyTorch packages from requirements before installing', async () => {
      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)

      // Capture filtered requirements content inside the uv handler,
      // before the orchestrator cleans up the temp file.
      const capturedFilteredContents: string[] = []
      spawnState.uvHandler = (args: string[]) => {
        if (args.includes('pip') && args.includes('install') && args.includes('-r')) {
          const rIdx = args.indexOf('-r')
          if (rIdx >= 0 && args[rIdx + 1]) {
            try {
              capturedFilteredContents.push(fs.readFileSync(args[rIdx + 1]!, 'utf-8'))
            } catch { /* file may not exist for this call */ }
          }
        }
        return fakeProc({ exitCode: 0 })
      }

      const opts = makeBaseOpts(installPath)
      await runComfyUIUpdate(opts)

      // The repo's requirements.txt contains 'torch==2.0' — verify it was stripped
      expect(capturedFilteredContents.length).toBeGreaterThan(0)
      for (const content of capturedFilteredContents) {
        expect(content).not.toMatch(/^torch==/m)
        expect(content).not.toMatch(/^torchvision==/m)
        expect(content).not.toMatch(/^torchaudio==/m)
      }
      // Non-PyTorch deps should still be present
      const mainReqs = capturedFilteredContents[0]!
      expect(mainReqs).toContain('foo==')
      expect(mainReqs).toContain('bar==')
    })
  })

  // -----------------------------------------------------------------------
  // 2. Marker parsing — real line-buffer parser against chunked stdout
  // -----------------------------------------------------------------------
  describe('marker parsing', () => {
    it('parses markers correctly when split across stdout chunks', async () => {
      spawnState.pythonHandler = (_args: string[]) => {
        // Advance git repo
        execFileSync('git', ['checkout', 'v0.2.0', '--detach'], {
          cwd: comfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        // Emit markers split across chunks to test the line-buffering logic
        return fakeProc({
          stdout: [
            '[PRE_UPDATE_HE',           // partial marker line
            `AD] ${repoShas.v1Sha}\n`,  // rest of first marker
            `[POST_UPDATE_HEAD] ${repoShas.v2Sha}\n[CHECKED_OUT_TAG] v0.2.0\n`, // two markers in one chunk
            '[BACKUP_BRANCH] backup\n',
          ],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { saveRollback: true })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)

      // Verify rollback data was parsed from chunked markers
      const updateFn = opts.update as ReturnType<typeof vi.fn>
      const calls = updateFn.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
      const rollbackCall = calls.find((c) => c.lastRollback !== undefined)
      expect(rollbackCall).toBeDefined()
      const rollback = rollbackCall!.lastRollback as Record<string, unknown>
      expect(rollback.preUpdateHead).toBe(repoShas.v1Sha)
      expect(rollback.postUpdateHead).toBe(repoShas.v2Sha)
      expect(rollback.backupBranch).toBe('backup')
    })
  })

  // -----------------------------------------------------------------------
  // 3. Cancellation — guards the production bugfix (signal.aborted check
  //    in spawnUpdateScript)
  // -----------------------------------------------------------------------
  describe('cancellation', () => {
    it('returns cancelled when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      spawnState.pythonHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { signal: controller.signal })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(false)
      expect(result.message).toBe('Cancelled')
    })
  })

  // -----------------------------------------------------------------------
  // 4. Version resolution — real git, real tag/commit counting
  // -----------------------------------------------------------------------
  describe('version resolution', () => {
    let aheadTmpDir: string
    let aheadInstallPath: string
    let aheadComfyuiDir: string
    let aheadShas: TestRepoShas

    beforeEach(() => {
      aheadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-orch-ahead-'))
      aheadInstallPath = aheadTmpDir
      aheadComfyuiDir = path.join(aheadInstallPath, 'ComfyUI')
      aheadShas = createTestRepo(aheadInstallPath, 3)
      fs.writeFileSync(path.join(aheadInstallPath, SENTINEL_UV_NAME), '')
      clearVersionCache()
    })

    afterEach(() => {
      fs.rmSync(aheadTmpDir, { recursive: true, force: true })
    })

    it('resolves commitsAhead when HEAD is beyond the latest tag', async () => {
      const targetSha = aheadShas.aheadShas[2]!

      spawnState.pythonHandler = () => {
        execFileSync('git', ['checkout', targetSha, '--detach'], {
          cwd: aheadComfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [`[POST_UPDATE_HEAD] ${targetSha}\n`],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(aheadInstallPath, { channel: 'latest' })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      expect(result.comfyVersion).toBeDefined()
      expect(result.comfyVersion!.commit).toBe(targetSha)
      expect(result.comfyVersion!.baseTag).toBe('v0.2.0')
      expect(result.comfyVersion!.commitsAhead).toBe(3)
    })

    it('resolves commitsAhead=1 for a single commit beyond tag', async () => {
      const targetSha = aheadShas.aheadShas[0]!

      spawnState.pythonHandler = () => {
        execFileSync('git', ['checkout', targetSha, '--detach'], {
          cwd: aheadComfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [`[POST_UPDATE_HEAD] ${targetSha}\n`],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(aheadInstallPath, { channel: 'latest' })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      expect(result.comfyVersion).toBeDefined()
      expect(result.comfyVersion!.commit).toBe(targetSha)
      expect(result.comfyVersion!.baseTag).toBe('v0.2.0')
      expect(result.comfyVersion!.commitsAhead).toBe(1)
    })

    it('formats version as tag+N for short style', async () => {
      const targetSha = aheadShas.aheadShas[2]!

      spawnState.pythonHandler = () => {
        execFileSync('git', ['checkout', targetSha, '--detach'], {
          cwd: aheadComfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [`[POST_UPDATE_HEAD] ${targetSha}\n`],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(aheadInstallPath, { channel: 'latest' })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      const shortVersion = formatComfyVersion(result.comfyVersion, 'short')
      expect(shortVersion).toBe('v0.2.0+3')

      const detailVersion = formatComfyVersion(result.comfyVersion, 'detail')
      expect(detailVersion).toBe(`v0.2.0 + 3 commits (${targetSha.slice(0, 7)})`)
    })

    it('stores correct installedTag in updateInfoByChannel', async () => {
      const targetSha = aheadShas.aheadShas[2]!

      spawnState.pythonHandler = () => {
        execFileSync('git', ['checkout', targetSha, '--detach'], {
          cwd: aheadComfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [`[POST_UPDATE_HEAD] ${targetSha}\n`],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(aheadInstallPath, { channel: 'latest' })
      await runComfyUIUpdate(opts)

      const updateFn = opts.update as ReturnType<typeof vi.fn>
      const calls = updateFn.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)
      const channelCall = calls.find((c) => c.updateInfoByChannel !== undefined)
      expect(channelCall).toBeDefined()

      const channelInfo = channelCall!.updateInfoByChannel as Record<string, Record<string, unknown>>
      expect(channelInfo.latest).toBeDefined()
      expect(channelInfo.latest!.installedTag).toBe('v0.2.0+3')
    })

    it('resolves exactly on tag with commitsAhead=0', async () => {
      spawnState.pythonHandler = () => {
        execFileSync('git', ['checkout', 'v0.2.0', '--detach'], {
          cwd: aheadComfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [
            `[POST_UPDATE_HEAD] ${aheadShas.v2Sha}\n`,
            `[CHECKED_OUT_TAG] v0.2.0\n`,
          ],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(aheadInstallPath, { channel: 'stable' })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      expect(result.comfyVersion!.baseTag).toBe('v0.2.0')
      expect(result.comfyVersion!.commitsAhead).toBe(0)
      expect(formatComfyVersion(result.comfyVersion, 'short')).toBe('v0.2.0')
    })
  })
})
