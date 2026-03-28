import path from 'path'
import { app } from 'electron'

/**
 * Resolve the path to a bundled Python script in the `lib/` directory.
 *
 * In packaged builds, scripts are in `process.resourcesPath/lib/`.
 * In dev mode, electron-vite bundles all main-process code into
 * `out/main/index.js`, so `__dirname` is always `out/main/` —
 * two levels below the project root where `lib/` lives.
 */
export function getBundledScriptPath(scriptName: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lib', scriptName)
    : path.join(__dirname, '..', '..', 'lib', scriptName)
}
