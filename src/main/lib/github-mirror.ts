import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { resolveGitDir, isPygit2Configured, getPygit2Config } from './git'

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
 * Run a pygit2 subcommand and return stdout lines.
 */
function runPygit2Ls(subcommand: string, args: string[]): Promise<string[]> {
  const { _pygit2Python, _pygit2Script } = getPygit2Config()
  if (!_pygit2Python || !_pygit2Script) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(_pygit2Python, ['-s', '-u', _pygit2Script, subcommand, ...args], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf-8',
    }, (err, stdout) => {
      if (err) { resolve([]); return }
      resolve(stdout.trim().split('\n').filter((l) => l.trim()))
    })
  })
}

/**
 * Fetch all version tags from a remote URL via `git ls-remote --tags`.
 * Uses pygit2 when system git is unavailable. Returns tag names or empty on error.
 */
export async function lsRemoteTags(url: string): Promise<string[]> {
  if (isPygit2Configured()) {
    return runPygit2Ls('ls-remote-tags', [url])
  }
  const refs = await runLsRemote(url, ['--tags'])
  return refs
    .map((r) => r.ref.replace(/^refs\/tags\//, ''))
    .filter((name) => /^v?\d/.test(name) && !name.endsWith('^{}'))
}

/**
 * Get the SHA of a specific ref (e.g. "refs/heads/master") from a remote URL.
 * Uses pygit2 when system git is unavailable.
 */
export async function lsRemoteRef(url: string, ref: string): Promise<string | null> {
  if (isPygit2Configured()) {
    const lines = await runPygit2Ls('ls-remote-ref', [url, ref])
    return lines[0] ?? null
  }
  const refs = await runLsRemote(url, ['--refs'])
  const match = refs.find((r) => r.ref === ref)
  return match?.sha ?? null
}
