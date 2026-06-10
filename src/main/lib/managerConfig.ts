import fs from 'fs'
import path from 'path'

// jsdelivr's GitHub CDN serves arbitrary github paths via /gh/<owner>/<repo>@<ref>/<file>
// and is reachable from regions where raw.githubusercontent.com fails. Mirrors the
// same content shape ComfyUI-Manager expects.
const MANAGER_MIRROR_CHANNEL_URL = 'https://cdn.jsdelivr.net/gh/ltdrdata/ComfyUI-Manager@main'

// ComfyUI-Manager's `security_level` values (most → least restrictive). These
// must match the strings Manager reads from config.ini's [default] section;
// `normal-` is the relaxed-on-localhost level. Manager has no API to change
// this — it is read once at startup — so Desktop owns it via config.ini.
export const MANAGER_SECURITY_LEVELS = ['strong', 'normal', 'normal-', 'weak'] as const
export type ManagerSecurityLevel = (typeof MANAGER_SECURITY_LEVELS)[number]

// Manager's own default when the key is absent. Pinned explicitly so the seeded
// config never relies on Manager's implicit fallback.
export const DEFAULT_MANAGER_SECURITY_LEVEL: ManagerSecurityLevel = 'normal'

function isManagerSecurityLevel(value: unknown): value is ManagerSecurityLevel {
  return (
    typeof value === 'string' && (MANAGER_SECURITY_LEVELS as readonly string[]).includes(value)
  )
}

// Modern ComfyUI's system-user-api path. Desktop ships a modern bundle so this
// is the target for fresh installs.
function modernConfigPath(installPath: string): string {
  return path.join(installPath, 'ComfyUI', 'user', '__manager', 'config.ini')
}

// Pre-system-user-api path. An adopted/migrated install may have one of these
// already; pre-seeding the modern path while this exists would trigger
// Manager's `migrate_legacy_config` flow (pip install + dir rename) silently.
function legacyConfigPath(installPath: string): string {
  return path.join(installPath, 'ComfyUI', 'user', 'default', 'ComfyUI-Manager', 'config.ini')
}

// Build the full config body for a fresh install. Mirror keys are included only
// when the user opted into the China-mirror flow; security_level is always set.
function buildManagerConfig(opts: {
  useChineseMirrors: boolean
  securityLevel: ManagerSecurityLevel
}): string {
  const lines = ['[default]']
  if (opts.useChineseMirrors) {
    lines.push(`channel_url = ${MANAGER_MIRROR_CHANNEL_URL}`)
    lines.push('bypass_ssl = true')
    lines.push('network_mode = public')
  }
  lines.push(`security_level = ${opts.securityLevel}`)
  return lines.join('\n') + '\n'
}

// Set `security_level` inside an existing config's [default] section, preserving
// every other key the user (or Manager) wrote. Returns the original string
// unchanged when the value already matches, so we avoid pointless rewrites.
function withSecurityLevel(content: string, level: ManagerSecurityLevel): string {
  const line = `security_level = ${level}`
  const existing = /^[ \t]*security_level[ \t]*=.*$/m
  if (existing.test(content)) {
    return content.replace(existing, line)
  }
  const defaultHeader = /^[ \t]*\[default\][^\n]*$/m
  if (defaultHeader.test(content)) {
    return content.replace(defaultHeader, (header) => `${header}\n${line}`)
  }
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
  return `${content}${separator}[default]\n${line}\n`
}

/**
 * Reconcile ComfyUI-Manager's config.ini with Desktop settings before launch.
 *
 * - Skips entirely when a legacy ComfyUI-Manager config exists, so we never
 *   trip Manager's legacy-migration path (pip install + dir rename).
 * - Fresh install: writes a new config carrying the chosen `security_level`
 *   (and the China-mirror keys when opted in). Writes nothing when neither a
 *   mirror nor an explicit security level is requested, preserving the prior
 *   no-seed behavior.
 * - Existing config: updates only `security_level` when the user picked one,
 *   leaving the rest of their file untouched. A user who never chose a level
 *   keeps full control of their file.
 */
export async function ensureManagerConfig(
  installPath: string,
  opts: { useChineseMirrors: boolean; securityLevel?: ManagerSecurityLevel } = {
    useChineseMirrors: false
  }
): Promise<void> {
  if (fs.existsSync(legacyConfigPath(installPath))) return

  const securityLevel = isManagerSecurityLevel(opts.securityLevel)
    ? opts.securityLevel
    : undefined
  const target = modernConfigPath(installPath)

  if (!fs.existsSync(target)) {
    if (!opts.useChineseMirrors && !securityLevel) return
    const content = buildManagerConfig({
      useChineseMirrors: opts.useChineseMirrors,
      securityLevel: securityLevel ?? DEFAULT_MANAGER_SECURITY_LEVEL
    })
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true })
      // 'wx' is atomic create-if-not-exists. A parallel writer wins, we no-op
      // (the EEXIST is the success signal).
      await fs.promises.writeFile(target, content, { flag: 'wx', encoding: 'utf-8' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
      throw err
    }
    return
  }

  // Existing config: only touch it when the user explicitly chose a level.
  if (!securityLevel) return
  const current = await fs.promises.readFile(target, 'utf-8')
  const updated = withSecurityLevel(current, securityLevel)
  if (updated !== current) {
    await fs.promises.writeFile(target, updated, 'utf-8')
  }
}

export const _internals = {
  MANAGER_MIRROR_CHANNEL_URL,
  buildManagerConfig,
  withSecurityLevel,
  modernConfigPath,
  legacyConfigPath,
}
