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

  // Pre-create directories that Electron expects to exist.
  // On Windows, Electron uses %APPDATA%/<appName> for userData.
  const appDataDir = process.platform === 'win32'
    ? path.join(homeDir, 'AppData', 'Roaming', 'comfyui-desktop-2')
    : path.join(homeDir, '.config', 'comfyui-desktop-2')
  await mkdir(appDataDir, { recursive: true })

  // Expose a CDP remote-debugging port so tests can connect to non-BrowserWindow
  // webContents (e.g. the ComfyUI WebContentsView) via chromium.connectOverCDP().
  // Use a random port in a high range to avoid conflicts with parallel runs.
  const cdpPort = 19200 + Math.floor(Math.random() * 800)

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
  // Adding an 'uncaughtException' handler suppresses the native error box; we log
  // the error to stderr instead so test output captures it.
  await application.evaluate(() => {
    process.on('uncaughtException', (err) => {
      console.error('[E2E] uncaughtException suppressed:', err)
    })
  })

  // Seed data files after launch so we can query app.getPath('userData') for
  // the correct directory (Electron may capitalize or modify the app name).
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
