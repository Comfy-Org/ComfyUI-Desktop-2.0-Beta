import { execFile } from 'child_process'

export const GITCODE_COMFY_ORG_BASE = 'https://gitcode.com/gh_mirrors/co'

const DEFAULT_COMFYUI_URL = 'https://github.com/Comfy-Org/ComfyUI/'

const COMFY_ORG_RE = /^(?:https?:\/\/|git@)github\.com[/:]Comfy-Org\/([^/]+?)(?:\.git)?\/?$/

export function rewriteCloneUrl(url: string, enabled: boolean): string {
  if (!enabled) return url
  const match = url.match(COMFY_ORG_RE)
  if (!match) return url
  return `${GITCODE_COMFY_ORG_BASE}/${match[1]}`
}

export function getComfyUIRemoteUrl(enabled: boolean): string {
  if (!enabled) return DEFAULT_COMFYUI_URL
  return `${GITCODE_COMFY_ORG_BASE}/ComfyUI`
}

/**
 * Ensure the git remote "origin" uses the correct URL based on the mirror
 * setting. Reads the current remote URL and updates it only if it needs to
 * change (github.com ↔ gitcode.com for Comfy-Org repos).
 */
export function ensureRemoteUrl(repoPath: string, enabled: boolean): Promise<void> {
  return new Promise((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(); return }
      const currentUrl = stdout.trim()
      const desired = rewriteCloneUrl(currentUrl, enabled)
      // If mirror is off, rewrite won't change github.com URLs, but we
      // need to restore them if they were previously rewritten to gitcode.
      const restored = enabled ? desired : restoreGitHubUrl(currentUrl)
      if (restored === currentUrl) { resolve(); return }
      execFile('git', ['remote', 'set-url', 'origin', restored], { cwd: repoPath, windowsHide: true, timeout: 5000 }, () => resolve())
    })
  })
}

const GITCODE_COMFY_RE = /^https?:\/\/gitcode\.com\/gh_mirrors\/co\/([^/]+?)(?:\.git)?\/?$/

function restoreGitHubUrl(url: string): string {
  const match = url.match(GITCODE_COMFY_RE)
  if (!match) return url
  return `https://github.com/Comfy-Org/${match[1]}`
}
