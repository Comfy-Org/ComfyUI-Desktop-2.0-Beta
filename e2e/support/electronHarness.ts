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
  /**
   * Merge into the seeded `settings.json` before launch. Use to bypass
   * one-time gates (e.g., `firstUseCompleted: true`) so a test isn't
   * racing the first-use takeover for control of the chooser host.
   */
  settings?: Record<string, unknown>
  /**
   * Runs after the isolated home + app-data dirs are created but before
   * the Electron app is spawned. Use to drop platform-specific files
   * (e.g. legacy Desktop `config.json` under `%APPDATA%/ComfyUI/`) the
   * main process inspects during early boot.
   */
  onSetup?: (paths: { homeDir: string; appDataDir: string }) => Promise<void>
}

export interface SeedInstallation {
  id?: string
  name?: string
  sourceId?: string
  installPath?: string
  status?: string
  /**
   * Snapshot JSON records to seed into `<installPath>/.launcher/snapshots/`.
   * Each entry is written as a standalone `<timestamp>-<trigger>-<6hex>.json`
   * file in the same format the live snapshot store produces.
   */
  snapshots?: SeedSnapshot[]
  [key: string]: unknown
}

/** Loose Snapshot shape — duplicated locally to keep the harness free of
 *  src/ imports. Keep in sync with `src/main/lib/snapshots/types.ts`. */
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
}

/** Mirrors `formatTimestamp` in `src/main/lib/snapshots/store.ts` so seeded
 *  filenames sort identically to live ones (newest-first by name). */
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
    // Gates `registerE2EHooks()` in main so test-only helpers
    // (`globalThis.__e2e`) are wired up. See `src/main/lib/e2eHooks.ts`.
    E2E: '1',
  }

  // On Windows, Electron resolves userData via APPDATA (%APPDATA%\<appName>).
  // Point it into the isolated home so the app doesn't touch the real profile.
  if (process.platform === 'win32') {
    env['APPDATA'] = path.join(homeDir, 'AppData', 'Roaming')
  }

  // Settings seed read by main `settings.maybeSeedFromEnv()` before first
  // load. Bypasses platform-specific userData path resolution (notably
  // macOS Application Support, which ignores HOME).
  if (settingsSeed && Object.keys(settingsSeed).length > 0) {
    env['E2E_SETTINGS_SEED'] = JSON.stringify(settingsSeed)
  }

  return env
}

export async function launchLauncherApp(options?: SeedOptions): Promise<LauncherAppHandle> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-e2e-'))

  // Pre-create the platform-specific config dir Electron's `userData`
  // (or our XDG override on Linux) resolves to. macOS Application Support
  // is rooted at `getpwuid(getuid())->pw_dir`, NOT $HOME — even when
  // HOME is overridden — so the directory lives outside the test's
  // mkdtemp sandbox. We still create it so `settings.set()` writes
  // succeed, and we seed the persisted settings via the
  // `E2E_SETTINGS_SEED` env var (read by main pre-chooser) instead of
  // by writing a settings.json file the harness would have to guess
  // the location of.
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
  // webContents (e.g. the ComfyUI WebContentsView) via chromium.connectOverCDP().
  // Derive port from Playwright worker index to avoid collisions in parallel runs.
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

  // The main window starts with show:false and transitions via ready-to-show.
  // Under Playwright the event may fire but isVisible() can lag, so force-show
  // once a BrowserWindow exists.
  const page = await application.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await application.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isVisible()) win.show()
  })

  // Prevent Electron's default uncaught-exception dialog from blocking E2E tests.
  // Suppress the native error dialog and exit immediately on uncaught exceptions
  // so tests fail fast instead of timing out.
  // Note: bare `process` is rewritten by Playwright's evaluate transpiler;
  // use app.exit() instead and access process via Electron's internals.
  await application.evaluate(({ app: electronApp, dialog }) => {
    // Suppress any native error/message dialogs
    dialog.showErrorBox = () => {}
    // Register uncaught exception handler via the app module
    electronApp.on('render-process-gone', () => electronApp.exit(1))
  })

  // Seed installations after launch so we can query app.getPath('userData')
  // for the correct directory (Electron may capitalize or modify the app
  // name on some platforms). Installations are read on chooser refresh, so
  // a post-launch write is fine.
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
    await rm(homeDir, { recursive: true, force: true })
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
