import fs from 'fs'
import path from 'path'

// jsdelivr's GitHub CDN serves arbitrary github paths via /gh/<owner>/<repo>@<ref>/<file>
// and is reachable from regions where raw.githubusercontent.com fails. Mirrors the
// same content shape ComfyUI-Manager expects.
const MANAGER_MIRROR_CHANNEL_URL = 'https://cdn.jsdelivr.net/gh/ltdrdata/ComfyUI-Manager@main'

// Explicit security_level pins Manager away from `force_security_level_if_needed`
// flipping behaviour for missing keys in a future Manager release.
const MANAGER_MIRROR_CONFIG = `[default]
channel_url = ${MANAGER_MIRROR_CHANNEL_URL}
bypass_ssl = true
network_mode = public
security_level = normal
`

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

/**
 * Seed ComfyUI-Manager's config.ini for users who opted into the China mirror
 * flow. Writes only when no config exists at either the modern or the legacy
 * path — returning users with their own customised config keep full control,
 * and migrated users don't accidentally trip Manager's legacy-migration path.
 */
export async function ensureManagerMirrorConfig(installPath: string): Promise<void> {
  if (fs.existsSync(legacyConfigPath(installPath))) return
  const target = modernConfigPath(installPath)
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    // 'wx' is atomic create-if-not-exists. A parallel writer wins, we no-op
    // (the EEXIST is the success signal).
    await fs.promises.writeFile(target, MANAGER_MIRROR_CONFIG, { flag: 'wx', encoding: 'utf-8' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
    throw err
  }
}

export const _internals = {
  MANAGER_MIRROR_CHANNEL_URL,
  MANAGER_MIRROR_CONFIG,
  modernConfigPath,
  legacyConfigPath,
}
