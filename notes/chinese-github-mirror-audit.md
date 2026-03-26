# Chinese GitHub Mirror Audit — Issue #299

## Overview

Add a toggle in Advanced settings to route GitHub operations through
`https://gitcode.com` for users in China. gitcode.com mirrors **git
repositories** (clone/fetch) but does **not** mirror the **GitHub Releases
API** or **release assets**.

The mirror URL pattern is:
```
https://github.com/{owner}/{repo}  →  https://gitcode.com/gh_mirrors/{short}/{repo}
```
where `{short}` is a 2-letter abbreviation (e.g. `co` for Comfy-Org repos).
However, we only need to support Comfy-Org repos, so we can maintain a
hardcoded mapping.

---

## gitcode.com Research Findings

### Releases: NOT mirrored
Confirmed by visiting `https://gitcode.com/gh_mirrors/co/ComfyUI/releases`:
- Shows **"Tag 134, Release 0, No Data"**
- gitcode mirrors git data (branches, tags, commits) but does **not** sync
  GitHub Releases or their attached assets
- This is a fundamental limitation — gitcode is a git-level mirror, not a
  GitHub feature mirror

### Storage & Bandwidth Limits (from gitcode docs)
- gitcode tracks: **Git repo storage, Container usage, Git LFS storage,
  Project count**
- Alerts at 80% quota, warnings at 95%
- No published hard numbers for free accounts — quotas appear per-user
- Git LFS is supported but subject to undisclosed quotas
- **No published release asset hosting or large-file distribution feature**

### Why gitcode.com CANNOT host Standalone-Environments releases
1. **No release asset feature**: gitcode mirrors don't have releases at all
   (confirmed: 0 releases shown even though GitHub has 134 tags)
2. **~20 GB per release**: Even if gitcode had releases, this volume would
   likely exceed any reasonable free-tier quota
3. **No API equivalent**: No `api.gitcode.com` endpoint that mirrors
   `api.github.com/repos/.../releases`
4. **Egress concern**: Chinese mirrors are typically free for reasonable
   open-source use, but 20 GB × thousands of users = serious bandwidth
5. **Sync automation**: No mechanism to auto-sync release assets from GitHub
   to gitcode — would require manual upload or custom CI

### What gitcode.com CAN do
- Mirror git clone/fetch operations for any popular GitHub repo
- Provide faster git access for Chinese users (code only, not releases)
- Sync branches and tags in near-real-time ("1小时前同步" = synced 1 hour ago)

---

## All Hardcoded GitHub Touchpoints

### Category A — Git Clone URLs (mirrorable ✅)

These use `github.com` URLs for `git clone` / `git fetch` operations.
gitcode.com mirrors these repos, so they can be rewritten.

| File | Line | URL / Pattern | Usage |
|------|------|---------------|-------|
| `sources/git.ts` | 11 | `https://github.com/Comfy-Org/ComfyUI/` | `DEFAULT_REPO` for git-source installs |
| `lib/snapshots.ts` | 1354 | `gitClone(targetNode.url, ...)` | Clones custom nodes from snapshot — URL comes from user data (could be any GitHub repo) |

### Category B — GitHub REST API: Replaceable via git commands ✅

These call `api.github.com` but can be replaced with local git operations
(git ls-remote, git fetch, git rev-list) against the gitcode mirror.

Standalone installs have a full `.git` repo at `ComfyUI/.git` — the code
unshallows it via `git fetch --unshallow origin --tags` (`fetchTags` in
`git.ts`). Version resolution already uses `git rev-list --count {tag}..{commit}`
locally. So the GitHub REST API is only used for discovering what the *remote*
latest version is, which `git ls-remote` + local git can replace.

| File | Line | URL / Pattern | Usage | Replacement |
|------|------|---------------|-------|-------------|
| `lib/comfyui-releases.ts` | 66 | `api.github.com/repos/${REPO}/tags` | Fetch latest semver tag | `git ls-remote --tags` against gitcode mirror |
| `lib/comfyui-releases.ts` | 87 | `api.github.com/repos/${REPO}/commits/master` | Get HEAD commit on master | `git ls-remote --refs origin master` |
| `lib/comfyui-releases.ts` | 88 | `api.github.com/repos/${REPO}/releases` | Find stable releases (fallback; tags take priority) | Not needed — tags are sufficient, code already handles tag-only path |
| `lib/comfyui-releases.ts` | 112 | `api.github.com/repos/${REPO}/compare/...` | Count commits ahead of tag | `git fetch` + `git rev-list --count {tag}..{sha}` (already implemented in `git.ts:194`) |
| `lib/comfyui-releases.ts` | 131 | `api.github.com/repos/${REPO}/releases` | Fetch releases for stable channel | Not needed — tag-only synthetic release path already exists (lines 142-154) |
| `sources/git.ts` | 358 | `api.github.com/repos/{owner}/{repo}` | Get default branch for git-source | `git ls-remote --symref origin HEAD` |
| `sources/git.ts` | 359 | `api.github.com/repos/{owner}/{repo}/branches` | List branches for git-source | `git ls-remote --heads` against mirror |
| `sources/git.ts` | 376 | `api.github.com/repos/{owner}/{repo}/commits` | List commits with messages for picker | `git log --oneline` after shallow clone (or omit messages, show SHAs only) |
| `lib/ipc.ts` | 604-607 | Multiple `api.github.com` URLs | Pre-warm ETag cache on startup | Skip when mirror enabled; use git-based checks instead |

### Category C — Standalone-Environments Release Assets (NOT mirrorable ❌, needs CDN)

These download binary assets (~20 GB/release) from GitHub Releases via
`browser_download_url` (redirects to `github-releases.githubusercontent.com`).
gitcode does not mirror releases or their assets. Portable source is not
relevant for China.

| File | Line | Usage |
|------|------|-------|
| `sources/standalone.ts` | 1557-1558 | List standalone environment releases via GitHub API |
| `sources/standalone.ts` | 1578 | Download `manifests.json` from release assets |
| `sources/standalone.ts` | 1591 | Download environment archive files |

### Category D — Display / OAuth Links (should NOT be rewritten)

| File | Line | URL | Usage |
|------|------|-----|-------|
| `lib/ipc.ts` | 1499 | `github.com/Comfy-Org/ComfyUI-Desktop-2.0-Beta` | "GitHub" link in About settings |
| `lib/comfyui-releases.ts` | 150 | `github.com/${REPO}/releases/tag/...` | `html_url` fallback for release links |
| `lib/allowedPopups.ts` | 9 | `github.com/login/oauth/` | GitHub OAuth popup allowlist |

---

## What Works With the Mirror

| Operation | Works? | Notes |
|-----------|--------|-------|
| `git clone` Comfy-Org repos | ✅ | Rewrite URL before clone |
| `git clone` custom nodes (any GitHub repo) | ⚠️ | gitcode mirrors popular repos but NOT all; need fallback |
| `git fetch` / `git pull` | ⚠️ | Only if the remote was set to gitcode at clone time |
| ComfyUI tag discovery | ✅ | `git ls-remote --tags` against gitcode (tags are synced) |
| ComfyUI HEAD/branch discovery | ✅ | `git ls-remote --heads` / `--refs` against gitcode |
| Commits-ahead count | ✅ | Already local: `git rev-list --count {tag}..{sha}` after `git fetch` from mirror |
| ComfyUI releases API | ✅ | Not needed — code already builds synthetic releases from tags alone |
| Git source branch/commit picker | ✅ | `git ls-remote --heads` / `--symref`; commit messages via shallow clone or omitted |
| Standalone-Environments releases API | ❌ | No mirror — needs Comfy-Org CDN |
| Standalone-Environments asset downloads | ❌ | No mirror — ~20 GB binaries, needs Comfy-Org CDN |
| Portable source | N/A | Not relevant for China |

---

## Things This Mirror Cannot Solve (Need Separate Solutions)

### 1. Standalone-Environments Release Assets
The standalone installer depends on the GitHub Releases API to discover
versions and download ~20 GB of binary archives per release. gitcode does not
mirror releases at all. Portable source is not relevant for China.

**Possible solutions:**
- **Comfy-Org hosted CDN**: Host release metadata (`manifests.json`) + assets
  on a Chinese CDN (e.g. Alibaba Cloud OSS, Tencent COS). The toggle would
  switch the base URL. A GitHub Actions workflow can upload assets to the CDN
  on each release.
- **Bundled release manifest**: Ship a static JSON manifest with the app that
  maps versions → download URLs on a Chinese CDN.

### 2. Custom Node Clone URLs
Snapshots store the original `github.com` URL for each custom node. When
restoring, we `git clone` that URL. We could rewrite `github.com` → `gitcode.com`
but gitcode doesn't mirror every repo. Many custom nodes are small/obscure repos
that won't be on gitcode.

**Possible solutions:**
- **Best-effort rewrite with fallback**: Try gitcode first, fall back to
  github.com on failure. Adds latency on miss.
- **Only rewrite known Comfy-Org repos**: Safer but less helpful.
- **ghproxy.com or other generic proxy**: A Chinese GitHub proxy service
  that works for any repo.

---

## Implementation Plan

### Phase 1 — Git Clone Rewriting + API Replacement (this PR)

1. **Setting**: Add `useChineseGitMirror: boolean` toggle to `KnownSettings`
2. **Settings UI**: Add a toggle in Advanced section (near pypiMirror)
3. **i18n**: Add label strings in `en.json` and `zh.json`
4. **URL rewriter** (`src/main/lib/github-mirror.ts`):
   - `rewriteCloneUrl(url: string, enabled: boolean): string`
   - Maps `github.com/Comfy-Org/{repo}` → `gitcode.com/gh_mirrors/co/{repo}`
   - For non-Comfy-Org repos, either pass through or try a generic pattern
5. **Replace GitHub REST API with git commands** (when mirror enabled):
   - `comfyui-releases.ts`: Replace `fetchLatestRelease` with git-based
     version that uses `git ls-remote --tags` to find latest tag, and
     `git ls-remote --refs origin master` for HEAD. Commits-ahead already
     uses local `git rev-list --count`. Releases API not needed — existing
     synthetic-release-from-tag path handles it.
   - `git.ts` (git source): Replace branch/commit API calls with
     `git ls-remote --symref origin HEAD` (default branch),
     `git ls-remote --heads` (branches). Commit listing can use
     `git log --oneline` after shallow clone or omit messages.
   - `ipc.ts`: Skip pre-warm GitHub API calls when mirror enabled.
6. **Thread clone URL rewriting through consumers**:
   - `git.ts` → rewrite `DEFAULT_REPO`
   - `snapshots.ts` → rewrite `targetNode.url` before `gitClone()`
   - `fetchTags` in `git.ts` → ensure fetch goes to gitcode remote
7. **Tests**: Unit tests for URL rewriting and git-based version discovery

### Phase 2 — Standalone-Environments CDN (future, needs Comfy-Org infrastructure)

- Host release metadata (`manifests.json`) + binary assets on Chinese CDN
  (e.g. Alibaba Cloud OSS, Tencent COS)
- Add GitHub Actions workflow to upload assets on each release
- When mirror toggle is on, `standalone.ts` fetches from CDN base URL
  instead of `api.github.com`

### Phase 3 — Hardening

- Fallback: if gitcode clone fails, retry with original `github.com`
- Timeout tuning: shorter timeouts for mirror attempts
- Status indicator: show which mirror is active in About section
