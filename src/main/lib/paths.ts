import { app } from 'electron'
import path from 'path'
import fs from 'fs'

const isLinux = process.platform === "linux";

const APP_NAME = "comfyui-desktop-2";

/**
 * XDG-compliant directory helpers for Linux.
 * On other platforms, falls back to Electron's userData path.
 *
 * XDG Base Directory Specification:
 *   XDG_CONFIG_HOME → ~/.config       (config files like settings.json)
 *   XDG_CACHE_HOME  → ~/.cache        (non-essential cached data like download-cache)
 *   XDG_DATA_HOME   → ~/.local/share  (persistent data like installations.json)
 *   XDG_STATE_HOME  → ~/.local/state  (runtime state like port-locks)
 */

export function configDir(): string {
  if (isLinux) {
    const base = process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

export function cacheDir(): string {
  if (isLinux) {
    const base = process.env.XDG_CACHE_HOME || path.join(app.getPath("home"), ".cache");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

export function dataDir(): string {
  if (isLinux) {
    const base = process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

export function stateDir(): string {
  if (isLinux) {
    const base = process.env.XDG_STATE_HOME || path.join(app.getPath("home"), ".local", "state");
    return path.join(base, APP_NAME);
  }
  return app.getPath("userData");
}

/** Windows only: the root of the drive the app was installed onto, when it
 *  differs from the user's home drive. The NSIS installer lets the user pick an
 *  install location (e.g. `D:\...`); this lets ComfyUI's large data dirs follow
 *  that drive instead of always landing on the system drive. Returns null on
 *  non-Windows, or when the app lives on the home drive (home is already the
 *  right default there). */
function selectedInstallDrive(): string | null {
  if (process.platform !== "win32") return null;
  try {
    // Explicit win32 parsing so the drive is extracted correctly regardless of
    // the host the code is exercised on (matches the platform `path` at runtime).
    const exeDrive = path.win32.parse(app.getPath("exe")).root;   // e.g. "D:\\"
    const homeDrive = path.win32.parse(app.getPath("home")).root; // e.g. "C:\\"
    if (!exeDrive) return null;
    if (exeDrive.toLowerCase() === homeDrive.toLowerCase()) return null;
    return exeDrive;
  } catch {
    return null;
  }
}

/** Windows system-drive layout for the large data dirs. New installs are
 *  grouped under `%LOCALAPPDATA%\Comfy-Desktop` (the standard per-user,
 *  non-roaming spot for large app data — the home root and roaming AppData are
 *  both poor fits); pre-existing installs keep their original home-root layout
 *  so an upgrade never strands a user's data. */
type WinSystemDriveMode = "legacy-home" | "local-appdata";

const DATA_ROOT_MARKER = "data-location.json";

let cachedWinMode: WinSystemDriveMode | undefined;

function winDataRootMarkerPath(): string {
  return path.join(dataDir(), DATA_ROOT_MARKER);
}

/** Classify a Windows system-drive install. A persisted marker wins so the
 *  choice can never flip between launches; otherwise an existing home-root
 *  footprint means an upgrade (keep home), and a clean machine is a new install
 *  (use LocalAppData). */
function classifyWinSystemDriveMode(): WinSystemDriveMode {
  try {
    const raw = fs.readFileSync(winDataRootMarkerPath(), "utf-8");
    const mode = (JSON.parse(raw) as { mode?: unknown }).mode;
    if (mode === "legacy-home" || mode === "local-appdata") return mode;
  } catch {}
  const home = app.getPath("home");
  const hasLegacyFootprint =
    fs.existsSync(path.join(home, "ComfyUI-Installs")) ||
    fs.existsSync(path.join(home, "ComfyUI-Shared"));
  return hasLegacyFootprint ? "legacy-home" : "local-appdata";
}

function winSystemDriveRoot(): string {
  cachedWinMode ??= classifyWinSystemDriveMode();
  if (cachedWinMode === "legacy-home") return app.getPath("home");
  const localAppData =
    process.env.LOCALAPPDATA || path.join(app.getPath("home"), "AppData", "Local");
  return path.join(localAppData, "Comfy-Desktop");
}

/** Persist the resolved Windows system-drive data-root choice once, so a new
 *  user's location can never flip on a later launch (e.g. if the legacy folders
 *  appear externally). No-op off win32, on a redirected install drive, or when a
 *  marker already exists. Call once after startup — never at module import. */
export function persistWinDataRootChoice(): void {
  if (process.platform !== "win32") return;
  if (selectedInstallDrive()) return; // redirected drive is already deterministic
  const markerPath = winDataRootMarkerPath();
  if (fs.existsSync(markerPath)) return;
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const mode = cachedWinMode ?? classifyWinSystemDriveMode();
    fs.writeFileSync(markerPath, JSON.stringify({ mode }), "utf-8");
  } catch {}
}

/** Base directory under which ComfyUI's large data dirs (installs, shared
 *  models/input/output, download cache) live by default. On Windows, when the
 *  app was installed to a non-system drive, this is a single `Comfy-Desktop`
 *  folder on that drive so everything stays grouped under one parent instead of
 *  scattering folders at the drive root. On a system-drive Windows install,
 *  new users get `%LOCALAPPDATA%\Comfy-Desktop` while existing users keep home.
 *  Non-Windows uses the user's home dir. */
export function defaultDataRoot(): string {
  const drive = selectedInstallDrive();
  if (drive) return path.join(drive, "Comfy-Desktop");
  if (process.platform === "win32") return winSystemDriveRoot();
  return app.getPath("home");
}

/** Default location for the multi-GB download cache. When the large data dirs
 *  are grouped under a `Comfy-Desktop` parent (a redirected drive, or a new
 *  Windows system-drive install), the cache lives there too; otherwise the
 *  platform cache dir (roaming userData on Windows/macOS, XDG cache on Linux). */
export function defaultDownloadCacheDir(): string {
  if (selectedInstallDrive()) {
    return path.join(defaultDataRoot(), "ComfyUI-Cache", "download-cache");
  }
  if (process.platform === "win32") {
    const root = winSystemDriveRoot();
    if (root !== app.getPath("home")) {
      return path.join(root, "ComfyUI-Cache", "download-cache");
    }
  }
  return path.join(cacheDir(), "download-cache");
}

/** Built-in fallback when no `installDir` setting is configured. */
export function builtinDefaultInstallDir(): string {
  return path.join(defaultDataRoot(), "ComfyUI-Installs");
}

/** Resolver for the user's configured install location, injected by settings.ts.
 *  Kept as injected state (not a direct `import`) so paths.ts has no dependency
 *  on settings — settings → models → paths is the only allowed direction, and
 *  importing settings here would re-enter paths before its top-level consts
 *  (e.g. `isLinux`) initialize. */
let installDirResolver: (() => string | undefined) | null = null;

export function setInstallDirResolver(resolver: () => string | undefined): void {
  installDirResolver = resolver;
}

/** Parent directory suggested for new installations. Honors the user's
 *  `installDir` Desktop Setting so every new-install path stays consistent;
 *  falls back to the built-in default. */
export function defaultInstallDir(): string {
  const configured = installDirResolver?.();
  if (typeof configured === "string" && configured.trim() !== "") {
    return configured;
  }
  return builtinDefaultInstallDir();
}

/** Migrate a file/dir to a new location (only if old exists and new doesn't). Uses
 *  copy+delete, not rename, to handle cross-filesystem moves. */
function migrateIfNeeded(oldPath: string, newPath: string): void {
  try {
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      const stat = fs.statSync(oldPath);
      if (stat.isDirectory()) {
        fs.cpSync(oldPath, newPath, { recursive: true });
      } else {
        fs.copyFileSync(oldPath, newPath);
      }
      fs.rmSync(oldPath, { recursive: true, force: true });
    }
  } catch (err: unknown) {
    console.error(`XDG migration failed: ${oldPath} → ${newPath}:`, (err as Error).message);
  }
}

/** Run all XDG migrations on Linux, once at startup, moving files from the old
 *  ~/.config/comfyui-desktop-2 location to proper XDG dirs. */
export function migrateXdgPaths(): void {
  if (!isLinux) return;
  const oldBase = app.getPath("userData"); // ~/.config/comfyui-desktop-2

  migrateIfNeeded(
    path.join(oldBase, "download-cache"),
    path.join(cacheDir(), "download-cache")
  );

  migrateIfNeeded(
    path.join(oldBase, "installations.json"),
    path.join(dataDir(), "installations.json")
  );

  migrateIfNeeded(
    path.join(oldBase, "shared_model_paths.yaml"),
    path.join(dataDir(), "shared_model_paths.yaml")
  );

  migrateIfNeeded(
    path.join(oldBase, "port-locks"),
    path.join(stateDir(), "port-locks")
  );

  migrateCacheDirSetting(oldBase);
}

/** Drop a settings.json cacheDir that still points at the old default so the XDG default applies. */
function migrateCacheDirSetting(oldBase: string): void {
  const settingsPath = path.join(configDir(), "settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return;
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const oldDefault = path.join(oldBase, "download-cache");
    if (settings.cacheDir && path.resolve(settings.cacheDir) === path.resolve(oldDefault)) {
      delete settings.cacheDir;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    }
  } catch (err: unknown) {
    console.error("Failed to migrate cacheDir setting:", (err as Error).message);
  }
}

export function homeDir(): string {
  return app.getPath("home");
}

/** Replace filesystem-unsafe characters with underscores for a directory component. */
export function sanitizeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'ComfyUI'
}

/** Allocate a unique dir under `parentDir`, appending a numeric suffix on collision. */
export function allocateUniqueDir(parentDir: string, dirName: string): string {
  let candidate = path.join(parentDir, dirName)
  let suffix = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDir, `${dirName} (${suffix})`)
    suffix++
  }
  return candidate
}
