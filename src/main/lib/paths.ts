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

/** Built-in fallback when no `installDir` setting is configured. */
export function builtinDefaultInstallDir(): string {
  return path.join(app.getPath("home"), "ComfyUI-Installs");
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
