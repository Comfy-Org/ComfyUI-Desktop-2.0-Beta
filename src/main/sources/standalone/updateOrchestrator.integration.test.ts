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
const SENTINEL_UV = '__TEST_UV__'
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
  getUvPath: () => SENTINEL_UV,
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
      if (command === SENTINEL_UV && spawnState.uvHandler) {
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
  process.nextTick(() => {
    process.nextTick(() => {
      proc.emit('close', exitCode, opts.exitSignal ?? null)
    })
  })
  return proc
}

/** Create a minimal git repo with tagged commits and a requirements file. */
function createTestRepo(installPath: string): { v1Sha: string; v2Sha: string } {
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

  // Point HEAD back to v0.1.0 (pre-update state)
  execFileSync('git', ['checkout', 'v0.1.0', '--detach'], gitOpts)

  return { v1Sha, v2Sha }
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

    // Create a file at the SENTINEL_UV path so fs.existsSync(getUvPath(...)) passes
    fs.writeFileSync(SENTINEL_UV, '')

    // Clear version-resolve cache between tests
    clearVersionCache()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    try { fs.unlinkSync(SENTINEL_UV) } catch {}
  })

  // -----------------------------------------------------------------------
  // 1. Happy path: latest update with changed requirements
  // -----------------------------------------------------------------------
  describe('happy path update', () => {
    it('returns ok=true with resolved version after successful update', async () => {
      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { channel: 'stable', saveRollback: true })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      expect(result.comfyVersion).toBeDefined()
      expect(result.comfyVersion!.commit).toBe(repoShas.v2Sha)
      expect(result.comfyVersion!.baseTag).toBe('v0.2.0')
      expect(result.comfyVersion!.commitsAhead).toBe(0)
    })

    it('calls update() with version data, channel, and rollback info', async () => {
      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { channel: 'stable', saveRollback: true })
      await runComfyUIUpdate(opts)

      // update() is called multiple times — the final one should have comfyVersion + rollback
      const updateFn = opts.update as ReturnType<typeof vi.fn>
      const calls = updateFn.mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>)

      const versionCall = calls.find((c) => c.comfyVersion !== undefined)
      expect(versionCall).toBeDefined()
      expect(versionCall!.updateChannel).toBe('stable')
      expect(versionCall!.updateInfoByChannel).toBeDefined()

      const rollbackCall = calls.find((c) => c.lastRollback !== undefined)
      expect(rollbackCall).toBeDefined()
      const rollback = rollbackCall!.lastRollback as Record<string, unknown>
      expect(rollback.postUpdateHead).toBe(repoShas.v2Sha)
      expect(rollback.channel).toBe('stable')
      expect(rollback.backupBranch).toBe('backup-pre-update')
    })

    it('invokes uv pip install when requirements change', async () => {
      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath)
      await runComfyUIUpdate(opts)

      // uv should have been called for both requirements.txt and manager_requirements.txt
      expect(spawnState.uvCalls.length).toBeGreaterThanOrEqual(1)
      // At least one call should include 'pip' and 'install'
      const pipInstalls = spawnState.uvCalls.filter(
        (args) => args.includes('pip') && args.includes('install'),
      )
      expect(pipInstalls.length).toBeGreaterThanOrEqual(1)
    })

    it('filters PyTorch packages from requirements before installing', async () => {
      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)

      // Capture the filtered requirements content during the uv handler
      // execution, before the orchestrator cleans up the temp file.
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

      // Verify we actually captured content and it excludes PyTorch
      expect(capturedFilteredContents.length).toBeGreaterThan(0)
      for (const content of capturedFilteredContents) {
        expect(content).not.toMatch(/^torch==/m)
        expect(content).not.toMatch(/^torchvision==/m)
        expect(content).not.toMatch(/^torchaudio==/m)
      }
    })
  })

  // -----------------------------------------------------------------------
  // 2. Dry-run conflict check
  // -----------------------------------------------------------------------
  describe('dry-run conflict check', () => {
    it('runs dry-run then proceeds with install even when dry-run fails', async () => {
      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)

      let uvCallCount = 0
      spawnState.uvHandler = (args: string[]) => {
        uvCallCount++
        if (args.includes('--dry-run')) {
          return fakeProc({
            exitCode: 1,
            stderr: ['Conflict detected: foo==2.0 vs foo==1.0\n'],
          })
        }
        return fakeProc({ exitCode: 0 })
      }

      const opts = makeBaseOpts(installPath, { dryRunConflictCheck: true })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      // Should have at least 2 uv calls: dry-run + install for requirements.txt
      expect(uvCallCount).toBeGreaterThanOrEqual(2)

      // Conflict warning should appear in output
      const outputFn = opts.sendOutput as ReturnType<typeof vi.fn>
      const allOutput = outputFn.mock.calls.map((c: unknown[]) => c[0] as string).join('')
      expect(allOutput).toContain('dry-run')
    })
  })

  // -----------------------------------------------------------------------
  // 3. No requirements change — no uv install
  // -----------------------------------------------------------------------
  describe('no requirements change', () => {
    it('skips uv install when requirements are unchanged', async () => {
      // Update handler that does NOT change requirements
      spawnState.pythonHandler = (_args: string[]) => {
        // Just make a new commit on the same requirements
        execFileSync('git', ['checkout', 'v0.1.0', '--detach'], {
          cwd: comfyuiDir, windowsHide: true, stdio: 'pipe',
        })
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: comfyuiDir, windowsHide: true, stdio: 'pipe',
        }).toString().trim()

        return fakeProc({
          stdout: [
            `[POST_UPDATE_HEAD] ${sha}\n`,
            `[CHECKED_OUT_TAG] v0.1.0\n`,
          ],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { dryRunConflictCheck: true })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)
      // No uv calls should have been made
      expect(spawnState.uvCalls.length).toBe(0)

      // Progress should show deps up to date
      const progressFn = opts.sendProgress as ReturnType<typeof vi.fn>
      const depsProgress = progressFn.mock.calls.filter(
        (c: unknown[]) => (c[0] as string) === 'deps',
      )
      const statuses = depsProgress.map(
        (c: unknown[]) => (c[1] as Record<string, unknown>).status as string,
      )
      expect(statuses.some((s) => s.includes('updateDepsUpToDate'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // 4. Update script failure
  // -----------------------------------------------------------------------
  describe('update script failure', () => {
    it('returns ok=false with error message when update script exits non-zero', async () => {
      spawnState.pythonHandler = () =>
        fakeProc({
          exitCode: 1,
          stderr: ['Error: something went wrong\nTraceback ...\nRuntimeError: bad\n'],
        })

      const opts = makeBaseOpts(installPath)
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(false)
      expect(result.message).toBeDefined()
      expect(result.message).toContain('updateFailed')
      // No uv calls should have happened
      expect(spawnState.uvCalls.length).toBe(0)
    })

    it('does not persist version data on failure', async () => {
      spawnState.pythonHandler = () => fakeProc({ exitCode: 1, stderr: ['fail\n'] })

      const opts = makeBaseOpts(installPath)
      await runComfyUIUpdate(opts)

      const updateFn = opts.update as ReturnType<typeof vi.fn>
      // update() should not have been called with comfyVersion
      for (const [data] of updateFn.mock.calls) {
        expect((data as Record<string, unknown>).comfyVersion).toBeUndefined()
      }
    })
  })

  // -----------------------------------------------------------------------
  // 5. Cancellation via AbortSignal
  // -----------------------------------------------------------------------
  describe('cancellation', () => {
    it('returns cancelled result when signal is aborted before update script', async () => {
      const controller = new AbortController()
      controller.abort()

      spawnState.pythonHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { signal: controller.signal })
      const result = await runComfyUIUpdate(opts)

      // The spawn mock returns immediately with code 1 when already aborted,
      // and then the function checks signal.aborted
      expect(result.ok).toBe(false)
      expect(result.message).toBe('Cancelled')
    })

    it('returns cancelled result when signal fires during update', async () => {
      const controller = new AbortController()

      spawnState.pythonHandler = (_args: string[]) => {
        const proc = new EventEmitter() as ChildProcess & { pid: number; killed: boolean }
        proc.stdout = new EventEmitter() as Readable
        proc.stderr = new EventEmitter() as Readable
        proc.stdout.destroy = vi.fn() as Readable['destroy']
        proc.stderr.destroy = vi.fn() as Readable['destroy']
        proc.pid = 99999
        proc.killed = false
        proc.kill = vi.fn(() => {
          proc.killed = true
          return true
        })

        // Abort after a tick, then emit close with non-zero
        process.nextTick(() => {
          controller.abort()
          process.nextTick(() => {
            proc.emit('close', 1, 'SIGTERM')
          })
        })

        return proc
      }

      const opts = makeBaseOpts(installPath, { signal: controller.signal })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(false)
      expect(result.message).toBe('Cancelled')
    })
  })

  // -----------------------------------------------------------------------
  // 6. Pre-update snapshot
  // -----------------------------------------------------------------------
  describe('pre-update snapshot', () => {
    it('saves a pre-update snapshot and deduplicates afterward', async () => {
      const { saveSnapshot, deduplicatePreUpdateSnapshot, getSnapshotCount } = await import('../../lib/snapshots')
      const mockedSave = vi.mocked(saveSnapshot)
      const mockedDedup = vi.mocked(deduplicatePreUpdateSnapshot)
      const mockedCount = vi.mocked(getSnapshotCount)
      mockedCount.mockResolvedValue(2)

      spawnState.pythonHandler = makeSuccessfulUpdateHandler(comfyuiDir, repoShas.v2Sha)
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { preUpdateSnapshot: true })
      const result = await runComfyUIUpdate(opts)

      expect(result.ok).toBe(true)

      // Should have called saveSnapshot for pre-update and post-update
      const saveCalls = mockedSave.mock.calls
      const triggers = saveCalls.map((c) => c[2])
      expect(triggers).toContain('pre-update')
      expect(triggers).toContain('post-update')

      // Should have attempted deduplication
      expect(mockedDedup).toHaveBeenCalledWith(installPath, 'pre-update-snap.json')
    })
  })

  // -----------------------------------------------------------------------
  // 7. Marker parsing across chunked stdout
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
  // 8. Latest channel
  // -----------------------------------------------------------------------
  describe('latest channel', () => {
    it('does not pass --stable flag for latest channel', async () => {
      let capturedArgs: string[] = []
      spawnState.pythonHandler = (args: string[]) => {
        capturedArgs = args

        execFileSync('git', ['checkout', 'v0.2.0', '--detach'], {
          cwd: comfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [`[POST_UPDATE_HEAD] ${repoShas.v2Sha}\n`],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { channel: 'latest' })
      await runComfyUIUpdate(opts)

      expect(capturedArgs).not.toContain('--stable')
    })

    it('passes --stable flag for stable channel', async () => {
      let capturedArgs: string[] = []
      spawnState.pythonHandler = (args: string[]) => {
        capturedArgs = args

        execFileSync('git', ['checkout', 'v0.2.0', '--detach'], {
          cwd: comfyuiDir, windowsHide: true, stdio: 'pipe',
        })

        return fakeProc({
          stdout: [`[POST_UPDATE_HEAD] ${repoShas.v2Sha}\n`],
          exitCode: 0,
        })
      }
      spawnState.uvHandler = () => fakeProc({ exitCode: 0 })

      const opts = makeBaseOpts(installPath, { channel: 'stable' })
      await runComfyUIUpdate(opts)

      expect(capturedArgs).toContain('--stable')
    })
  })
})
