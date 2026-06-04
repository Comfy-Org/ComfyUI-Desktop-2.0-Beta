import fs from 'fs'
import path from 'path'

// Reachable from regions where raw.githubusercontent.com fails and serves
// arbitrary github paths via /gh/<owner>/<repo>@<ref>/<file>.
const MANAGER_MIRROR_CHANNEL_URL = 'https://cdn.jsdelivr.net/gh/ltdrdata/ComfyUI-Manager@main'

const MANAGER_MIRROR_CONFIG = `[default]
channel_url = ${MANAGER_MIRROR_CHANNEL_URL}
bypass_ssl = true
network_mode = public
`

// Modern ComfyUI's system-user-api path. Older ComfyUI uses a different layout
// (user/default/ComfyUI-Manager) — Desktop ships a modern bundle so we target
// the modern path only; if a migrated install ends up on old ComfyUI the
// untouched legacy config simply keeps Manager's current behavior.
function managerConfigPath(installPath: string): string {
  return path.join(installPath, 'ComfyUI', 'user', '__manager', 'config.ini')
}

/**
 * Seed ComfyUI-Manager's config.ini with mirror-friendly defaults for users
 * who opted into the China mirror flow. Writes only when the file doesn't
 * already exist — a returning user with their own customized config keeps
 * full control.
 */
export async function ensureManagerMirrorConfig(installPath: string): Promise<void> {
  const target = managerConfigPath(installPath)
  if (fs.existsSync(target)) return
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  await fs.promises.writeFile(target, MANAGER_MIRROR_CONFIG, 'utf-8')
}

export const _internals = {
  MANAGER_MIRROR_CHANNEL_URL,
  MANAGER_MIRROR_CONFIG,
  managerConfigPath,
}
