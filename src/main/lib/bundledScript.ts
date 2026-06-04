import path from 'path'
import { app } from 'electron'

/** Resolve a bundled Python script's path. Packaged: `resourcesPath/lib/`;
 *  dev: two levels below `out/main/` where `lib/` lives. */
export function getBundledScriptPath(scriptName: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'lib', scriptName)
    : path.join(__dirname, '..', '..', 'lib', scriptName)
}
