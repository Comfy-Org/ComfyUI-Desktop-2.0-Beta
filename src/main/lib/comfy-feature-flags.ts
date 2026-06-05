/**
 * Discovers the CLI-settable feature-flag registry via
 * `python main.py --list-feature-flags`, so the launcher only injects
 * `--feature-flag KEY=VALUE` for flags this ComfyUI version knows. Returns an
 * empty registry (= inject nothing) on any failure.
 */

import { execFile } from 'child_process'
import * as path from 'path'

export interface FeatureFlagInfo {
  type: string
  default: unknown
  description: string
}

export type FeatureFlagRegistry = Record<string, FeatureFlagInfo>

const registryCache = new Map<string, { registry: FeatureFlagRegistry; version: string }>()

/**
 * Parse the JSON stdout from `--list-feature-flags`. Returns `{}` on
 * malformed input, non-object payloads, or empty strings.
 */
export function parseFeatureFlagOutput(stdout: string): FeatureFlagRegistry {
  if (!stdout) return {}
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as FeatureFlagRegistry
    }
  } catch {
    /* fall through */
  }
  return {}
}

/** Run `--list-feature-flags` and parse it, cached per (installationId,
 *  version). Returns {} on any error. */
export async function getComfyFeatureFlagRegistry(
  pythonPath: string,
  mainPyPath: string,
  cwd: string,
  installationId: string,
  version?: string,
): Promise<FeatureFlagRegistry> {
  const cached = registryCache.get(installationId)
  if (cached && version && cached.version === version) {
    return cached.registry
  }

  let registry: FeatureFlagRegistry = {}
  try {
    const stdout = await runListFeatureFlags(pythonPath, mainPyPath, cwd)
    registry = parseFeatureFlagOutput(stdout)
  } catch (err) {
    console.warn('[comfy-feature-flags] Could not get registry:', (err as Error).message)
  }

  registryCache.set(installationId, { registry, version: version ?? '' })
  return registry
}

/**
 * Read the cached registry without ever spawning Python. Returns `null` when
 * nothing is cached for the install (e.g. discovery hasn't run, or failed).
 * A blank cached version matches any requested version so launches that lacked
 * a version string still hit.
 */
export function getCachedFeatureFlagRegistry(
  installationId: string,
  version?: string,
): FeatureFlagRegistry | null {
  const cached = registryCache.get(installationId)
  if (!cached) return null
  if (version !== undefined && cached.version !== '' && cached.version !== version) {
    return null
  }
  return cached.registry
}

/** Whether a CLI feature flag is known to the install's ComfyUI, read from the
 *  cache only (no spawn). Treats an absent cache as "not available". */
export function isCachedFeatureFlagAvailable(
  installationId: string,
  key: string,
  version?: string,
): boolean {
  return key in (getCachedFeatureFlagRegistry(installationId, version) ?? {})
}

function runListFeatureFlags(pythonPath: string, mainPyPath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mainPyRel = path.relative(cwd, mainPyPath)
    execFile(
      pythonPath,
      ['-s', mainPyRel, '--list-feature-flags'],
      { cwd, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ''
          reject(new Error(`--list-feature-flags failed: ${err.message}${detail}`))
          return
        }
        if (!stdout) {
          reject(new Error('Empty --list-feature-flags output'))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/** Clear the registry cache for an installation (e.g. after version update). */
export function clearFeatureFlagRegistryCache(installationId: string): void {
  registryCache.delete(installationId)
}
