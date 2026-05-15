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
}

export interface SeedInstallation {
  id?: string
  name?: string
  sourceId?: string
  installPath?: string
  status?: string
  [key: string]: unknown
}

function buildIsolatedEnv(homeDir: string): Record<string, string> {
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

  return env
}

export async function launchLauncherApp(options?: SeedOptions): Promise<LauncherAppHandle> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'comfyui-launcher-e2e-'))

  // Candidate userData / configDir locations the main process may read
  // `settings.json` from. We seed every plausible location for the host
  // OS so the seed lands regardless of whether `app.name` resolves to
  // the package.json name (`comfyui-desktop-2`) or Electron's binary
  // name (`Electron`) for the non-packaged test launch:
  //   - Linux: `${XDG_CONFIG_HOME}/comfyui-desktop-2` — `configDir()`
  //     reads XDG_CONFIG_HOME on Linux, which the harness env points at
  //     `${homeDir}/.config`.
  //   - Windows: `${APPDATA}/comfyui-desktop-2` — Electron's `userData`
  //     uses APPDATA, which the harness env points at
  //     `${homeDir}/AppData/Roaming`.
  //   - macOS: `${HOME}/Library/Application Support/{comfyui-desktop-2,Electron}`
  //     — Electron's `userData` is `${HOME}/Library/Application Support/{appName}`,
  //     and `appName` may resolve to either depending on how the run
  //     binary is set up; seeding both is the safe play.
  const appDataDirs = process.platform === 'win32'
    ? [path.join(homeDir, 'AppData', 'Roaming', 'comfyui-desktop-2')]
    : process.platform === 'darwin'
      ? [
          path.join(homeDir, 'Library', 'Application Support', 'comfyui-desktop-2'),
          path.join(homeDir, 'Library', 'Application Support', 'Electron'),
        ]
      : [path.join(homeDir, '.config', 'comfyui-desktop-2')]
  for (const dir of appDataDirs) {
    await mkdir(dir, { recursive: true })
  }

  // Settings are seeded BEFORE launch so the renderer's first read sees them.
  // Without this, gates like `firstUseCompleted` race the renderer mount
  // (the first-use takeover would briefly open and lock the title bar).
  if (options?.settings && Object.keys(options.settings).length > 0) {
    const { writeFile: writeFileFs } = await import('node:fs/promises')
    const json = JSON.stringify(options.settings, null, 2)
    for (const dir of appDataDirs) {
      await writeFileFs(path.join(dir, 'settings.json'), json)
    }
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
    env: buildIsolatedEnv(homeDir),
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
    const records = options.installations.map((inst, i) => ({
      id: inst.id ?? `inst-test-${i}`,
      name: inst.name ?? `Test Install ${i + 1}`,
      createdAt: new Date().toISOString(),
      installPath: inst.installPath ?? path.join(homeDir, `install-${i}`),
      sourceId: inst.sourceId ?? 'standalone',
      status: inst.status ?? 'installed',
      ...inst,
    }))
    const { writeFile: writeFileFs } = await import('node:fs/promises')
    await mkdir(userDataDir, { recursive: true })
    await writeFileFs(
      path.join(userDataDir, 'installations.json'),
      JSON.stringify(records, null, 2),
    )
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
