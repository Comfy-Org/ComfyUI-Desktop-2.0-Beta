import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { _electron as electron, type ElectronApplication } from 'playwright'

export interface LauncherAppHandle {
  application: ElectronApplication
  homeDir: string
  /** CDP remote-debugging port for connecting to non-BrowserWindow webContents. */
  cdpPort: number
  cleanup: () => Promise<void>
}

export interface SeedOptions {
  /** Seed installation records into the isolated data directory. */
  installations?: SeedInstallation[]
  /** Merge into the seeded `settings.json` to bypass one-time gates (e.g.
   *  `firstUseCompleted`) so a test isn't racing the first-use takeover. */
  settings?: Record<string, unknown>
  /** Runs after the isolated dirs are created but before launch. Use to drop
   *  platform-specific files the main process inspects during early boot. */
  onSetup?: (paths: { homeDir: string; appDataDir: string }) => Promise<void>
}

export interface SeedInstallation {
  id?: string
  name?: string
  sourceId?: string
  installPath?: string
  status?: string
  /** Snapshot JSON records to seed into `<installPath>/.launcher/snapshots/`,
   *  written in the same format the live snapshot store produces. */
  snapshots?: SeedSnapshot[]
  [key: string]: unknown
}

/** Loose Snapshot shape duplicated to keep the harness free of src/ imports.
 *  Keep in sync with `src/main/lib/snapshots/types.ts`. */
export interface SeedSnapshot {
  version?: 1
  createdAt?: string
  trigger: 'boot' | 'restart' | 'manual' | 'pre-update' | 'post-update' | 'post-restore'
  label?: string | null
  comfyui: {
    ref: string
    commit: string | null
    releaseTag: string
    variant: string
    baseTag?: string
    commitsAhead?: number
  }
  customNodes?: unknown[]
  pipPackages?: Record<string, string>
  pythonVersion?: string
  updateChannel?: string
  /** Makes `snapshot-restore` skip the live pip phase (no real `uv`/Python). */
  skipPipSync?: boolean
}

/** Must mirror `formatTimestamp` in `src/main/lib/snapshots/store.ts` so
 *  seeded filenames sort identically to live ones (newest-first by name). */
function formatSeedTimestamp(date: Date): string {
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`
}

function buildIsolatedEnv(homeDir: string, settingsSeed?: Record<string, unknown>): Record<string, string> {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )

  const env: Record<string, string> = {
    ...inheritedEnv,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
    // Gates `registerE2EHooks()` in main so `globalThis.__e2e` is wired up.
    E2E: '1',
  }

  // Windows resolves userData via APPDATA; point it into the isolated home
  // so the app doesn't touch the real profile.
  if (process.platform === 'win32') {
    env['APPDATA'] = path.join(homeDir, 'AppData', 'Roaming')
  }

  // Settings seed read by main before first load. Needed because on macOS
  // Application Support ignores our HOME override, so a prior dev session's
  // `firstUseCompleted: true` would persist and wedge cold-start tests.
  // Always send a seed for a known-clean state; caller overrides win on merge.
  const effectiveSeed: Record<string, unknown> = {
    firstUseCompleted: false,
    telemetryEnabled: false,
    ...(settingsSeed ?? {}),
  }
  env['E2E_SETTINGS_SEED'] = JSON.stringify(effectiveSeed)

  return env
}

export async function launchLauncherApp(options?: SeedOptions): Promise<LauncherAppHandle> {
  // Honor `LIFECYCLE_REUSE_DIR` to reuse a previous run's profile dir so a
  // rerun doesn't redo the ~2-minute install. A reused dir is preserved on
  // cleanup; a fresh dir is printed so the operator can re-export it.
  const reuseDir = process.env['LIFECYCLE_REUSE_DIR']
  const homeDir = reuseDir ?? await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-e2e-'))
  if (reuseDir) {
    console.log(`[lifecycle-harness] reusing profile dir: ${homeDir}`)
  } else {
    console.log(`[lifecycle-harness] fresh profile dir: ${homeDir}`)
    console.log(`[lifecycle-harness] re-export as LIFECYCLE_REUSE_DIR=${homeDir} to rerun individual tests against this profile`)
  }

  // Pre-create the platform-specific config dir Electron resolves to so
  // `settings.set()` writes succeed. On macOS this lives outside the mkdtemp
  // sandbox (Application Support ignores HOME), so persisted settings are
  // seeded via `E2E_SETTINGS_SEED` rather than a settings.json file here.
  const appDataDir = process.platform === 'win32'
    ? path.join(homeDir, 'AppData', 'Roaming', 'comfyui-desktop-2')
    : process.platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Application Support', 'comfyui-desktop-2')
      : path.join(homeDir, '.config', 'comfyui-desktop-2')
  await mkdir(appDataDir, { recursive: true })

  if (options?.onSetup) {
    await options.onSetup({ homeDir, appDataDir })
  }

  // Expose a CDP remote-debugging port so tests can connect to non-BrowserWindow
  // webContents. Derive the port from the worker index to avoid collisions.
  const workerIndex = parseInt(process.env['TEST_WORKER_INDEX'] || '0', 10)
  const cdpPort = 19200 + workerIndex

  // Linux CI runners lack the SUID sandbox binary; disable it the same way linux-dev.sh does.
  const args = ['.', `--remote-debugging-port=${cdpPort}`]
  if (process.platform === 'linux') {
    args.push('--no-sandbox')
  }

  const application = await electron.launch({
    args,
    env: buildIsolatedEnv(homeDir, options?.settings),
  })

  // Under Playwright the ready-to-show event may fire but isVisible() can lag,
  // so force-show once a BrowserWindow exists.
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isVisible()) win.show()
  })

  // Suppress the native uncaught-exception dialog and exit fast so tests don't
  // time out. `process` is rewritten by Playwright's transpiler, so use app.exit().
  await application.evaluate(({ app: electronApp, dialog }) => {
    dialog.showErrorBox = () => {}
    electronApp.on('render-process-gone', () => electronApp.exit(1))
  })

  // Seed installations after launch so we can query app.getPath('userData')
  // for the correct dir (Electron may modify the app name per platform).
  if (options?.installations && options.installations.length > 0) {
    const userDataDir = await application.evaluate(async ({ app: electronApp }) => {
      return electronApp.getPath('userData')
    })
    const records = options.installations.map((inst, i) => {
      const { snapshots: _snapshots, ...rest } = inst
      return {
        id: inst.id ?? `inst-test-${i}`,
        name: inst.name ?? `Test Install ${i + 1}`,
        createdAt: new Date().toISOString(),
        installPath: inst.installPath ?? path.join(homeDir, `install-${i}`),
        sourceId: inst.sourceId ?? 'standalone',
        status: inst.status ?? 'installed',
        ...rest,
      }
    })
    const { writeFile: writeFileFs } = await import('node:fs/promises')
    await mkdir(userDataDir, { recursive: true })
    await writeFileFs(
      path.join(userDataDir, 'installations.json'),
      JSON.stringify(records, null, 2),
    )
    // Seed snapshot JSON files under `<installPath>/.launcher/snapshots/` so
    // the snapshots tab finds them on first read.
    for (let i = 0; i < options.installations.length; i++) {
      const snaps = options.installations[i]!.snapshots
      if (!snaps || snaps.length === 0) continue
      const installPath = records[i]!.installPath
      const snapshotsDir = path.join(installPath, '.launcher', 'snapshots')
      await mkdir(snapshotsDir, { recursive: true })
      for (let j = 0; j < snaps.length; j++) {
        const s = snaps[j]!
        const createdAt = s.createdAt ?? new Date(Date.now() - (snaps.length - j) * 1000).toISOString()
        const full = {
          version: 1,
          createdAt,
          trigger: s.trigger,
          label: s.label ?? null,
          comfyui: s.comfyui,
          customNodes: s.customNodes ?? [],
          pipPackages: s.pipPackages ?? {},
          pythonVersion: s.pythonVersion,
          updateChannel: s.updateChannel ?? 'stable',
          ...(s.skipPipSync ? { skipPipSync: true } : {}),
        }
        const filename = `${formatSeedTimestamp(new Date(createdAt))}-${s.trigger}-${(j + 1).toString(16).padStart(6, '0')}.json`
        await writeFileFs(path.join(snapshotsDir, filename), JSON.stringify(full, null, 2))
      }
    }
  }

  const cleanup = async (): Promise<void> => {
    try {
      const proc = application.process()
      if (proc && proc.exitCode === null) {
        await application.close().catch(() => {})
      }
    } catch {
      // Application already closed / disconnected — nothing to clean up.
    }
    // Preserve the reuse dir so the next `LIFECYCLE_REUSE_DIR=<path>`
    // invocation can pick it up. Only wipe dirs we created ourselves.
    if (!reuseDir) {
      await rm(homeDir, { recursive: true, force: true })
    }
  }

  return { application, homeDir, cdpPort, cleanup }
}

export async function waitForAppExit(application: ElectronApplication, timeoutMs = 10_000): Promise<void> {
  const child = application.process()
  if (child.exitCode !== null) return

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error(`Electron app did not exit within ${timeoutMs}ms`))
    }, timeoutMs)

    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }

    child.once('exit', onExit)
  })
}
