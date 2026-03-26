import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { resolveGitDir, isPygit2Configured } from './git'

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
 * setting. Reads and updates `.git/config` directly so it works even when
 * system git is unavailable (pygit2-only environments).
 */
export function ensureRemoteUrl(repoPath: string, enabled: boolean): Promise<void> {
  try {
    const gitDir = resolveGitDir(repoPath)
    if (!gitDir) return Promise.resolve()
    const configPath = path.join(gitDir, 'config')
    const content = fs.readFileSync(configPath, 'utf-8')
    const match = content.match(/(\[remote "origin"\][^[]*?url\s*=\s*)(.+)/m)
    if (!match) return Promise.resolve()
    const currentUrl = match[2]!.trim()
    const desired = enabled ? rewriteCloneUrl(currentUrl, true) : restoreGitHubUrl(currentUrl)
    if (desired === currentUrl) return Promise.resolve()
    const updated = content.replace(match[0]!, match[1]! + desired)
    fs.writeFileSync(configPath, updated, 'utf-8')
  } catch {}
  return Promise.resolve()
}

const GITCODE_COMFY_RE = /^https?:\/\/gitcode\.com\/gh_mirrors\/co\/([^/]+?)(?:\.git)?\/?$/

function restoreGitHubUrl(url: string): string {
  const match = url.match(GITCODE_COMFY_RE)
  if (!match) return url
  return `https://github.com/Comfy-Org/${match[1]}`
}

// ---------------------------------------------------------------------------
// git ls-remote helpers — used to query the mirror without GitHub REST API
// ---------------------------------------------------------------------------

interface LsRemoteRef {
  sha: string
  ref: string
}

function runLsRemote(url: string, args: string[]): Promise<LsRemoteRef[]> {
  // git ls-remote requires system git; if only pygit2 is configured we
  // cannot run it — callers should fall back to the GitHub API path.
  if (isPygit2Configured()) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile('git', ['ls-remote', ...args, url], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf-8',
    }, (err, stdout) => {
      if (err) { resolve([]); return }
      const refs: LsRemoteRef[] = []
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue
        const [sha, ref] = line.split(/\s+/)
        if (sha && ref) refs.push({ sha, ref })
      }
      resolve(refs)
    })
  })
}

/**
 * Fetch all version tags from a remote URL via `git ls-remote --tags`.
 * Returns tag names sorted by semver descending, or empty on error.
 */
export async function lsRemoteTags(url: string): Promise<string[]> {
  const refs = await runLsRemote(url, ['--tags'])
  // Filter to v* tags, strip refs/tags/ prefix, ignore ^{} derefs
  return refs
    .map((r) => r.ref.replace(/^refs\/tags\//, ''))
    .filter((name) => /^v?\d/.test(name) && !name.endsWith('^{}'))
}

/**
 * Get the SHA of a specific ref (e.g. "refs/heads/master") from a remote URL.
 */
export async function lsRemoteRef(url: string, ref: string): Promise<string | null> {
  const refs = await runLsRemote(url, ['--refs'])
  const match = refs.find((r) => r.ref === ref)
  return match?.sha ?? null
}
