/**
 * Download pre-built bootstrap-python archives from a GitHub release.
 *
 * Called before `todesktop build` (or local electron-builder) to ensure
 * the platform-specific bootstrap-python directories exist under
 * bootstrap-python/{win-x64,mac-arm64,linux-x64}/.
 *
 * Usage:
 *   node scripts/fetch-bootstrap-python.mjs [--tag bootstrap-v1] [--platform win-x64]
 *   node scripts/fetch-bootstrap-python.mjs [--tag bootstrap-v1] [--output-dir /path/to/dir]
 *
 * Options:
 *   --platform   Fetch only this platform (default: all platforms)
 *   --output-dir Override the output base directory (default: bootstrap-python/ in project root)
 *   --tag        Release tag to fetch from (default: bootstrap-v1)
 *   --soft-fail  Exit 0 even when a platform fails to fetch or verify. Intended
 *                for local dev — `predev` already prints a warning when the
 *                directory is missing. Production builds MUST NOT pass this:
 *                a silent fetch failure is what shipped 0.6.4 without
 *                bootstrap-python, stranding new installs on the bundled
 *                ComfyUI version.
 *
 * Uses GITHUB_TOKEN env var for authenticated downloads if set.
 * Skips platforms whose directory already exists.
 */

import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outputBase = path.join(projectRoot, 'bootstrap-python')

const PLATFORMS = ['win-x64', 'mac-arm64', 'linux-x64']
const DEFAULT_TAG = 'bootstrap-v1'
const REPO = 'Comfy-Org/ComfyUI-Desktop-2.0-Beta'

// Each platform's expected Python binary inside its bootstrap-python dir.
// Used by verifyPlatform() so a partial / corrupt extract doesn't pass.
const PYTHON_BINARY = {
  'win-x64': 'python.exe',
  'mac-arm64': path.join('bin', 'python3'),
  'linux-x64': path.join('bin', 'python3'),
}

function parseArgs() {
  const args = process.argv.slice(2)
  let tag = DEFAULT_TAG
  let platform = null
  let outputDir = null
  let softFail = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      tag = args[++i]
    } else if (args[i] === '--platform' && args[i + 1]) {
      platform = args[++i]
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i]
    } else if (args[i] === '--soft-fail') {
      softFail = true
    }
  }
  return { tag, platform, outputDir, softFail }
}

async function fetchReleaseAssets(tag) {
  const token = process.env.GITHUB_TOKEN
  const headers = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`

  // Try the tags endpoint first (works for published releases)
  const tagUrl = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`
  const tagResponse = await fetch(tagUrl, { headers })
  if (tagResponse.ok) {
    const release = await tagResponse.json()
    return release.assets || []
  }

  // Fall back to listing all releases (includes drafts, requires auth)
  const listUrl = `https://api.github.com/repos/${REPO}/releases?per_page=50`
  const listResponse = await fetch(listUrl, { headers })
  if (!listResponse.ok) {
    throw new Error(`Failed to list releases: ${listResponse.status} ${listResponse.statusText}`)
  }
  const releases = await listResponse.json()
  const release = releases.find((r) => r.tag_name === tag)
  if (!release) {
    throw new Error(`Release ${tag} not found (checked ${releases.length} releases)`)
  }
  return release.assets || []
}

async function downloadAndExtract(url, destDir) {
  const token = process.env.GITHUB_TOKEN
  const headers = { Accept: 'application/octet-stream' }
  if (token) headers.Authorization = `Bearer ${token}`

  const response = await fetch(url, { headers })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`)
  }

  // Save to temp file first, then extract with tar
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  const tmpFile = `${destDir}.tar.gz`
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpFile))
    execSync(`tar -xzf "${tmpFile}" -C "${path.dirname(destDir)}"`, { stdio: 'inherit' })
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
}

function verifyPlatform(outBase, platform) {
  const destDir = path.join(outBase, platform)
  const binaryRel = PYTHON_BINARY[platform]
  if (!binaryRel) {
    // Unknown platform — nothing to verify against. Treat as caller error.
    throw new Error(`Unknown platform ${platform}: no Python binary path configured`)
  }
  const binaryPath = path.join(destDir, binaryRel)
  if (!fs.existsSync(binaryPath)) {
    throw new Error(
      `Expected ${binaryPath} after fetch, but it does not exist. The archive may have been partial, ` +
      `extraction may have failed, or the directory was empty before the fetch ran. This installer ` +
      `would ship without bootstrap pygit2 — refusing to continue.`
    )
  }
}

async function main() {
  const { tag, platform: onlyPlatform, outputDir, softFail } = parseArgs()
  const platforms = onlyPlatform ? [onlyPlatform] : PLATFORMS
  const outBase = outputDir || outputBase
  console.log(`Fetching bootstrap-python archives from release ${tag}`)
  if (softFail) console.log('  --soft-fail: failures will be logged but not exit non-zero')

  // Track per-platform outcome so we can fail loudly at the end if any
  // requested platform did not end up with a usable bootstrap-python dir.
  const failures = []
  const recordFailure = (platform, err) => {
    failures.push({ platform, message: err instanceof Error ? err.message : String(err) })
    console.error(`  ${platform}: FAILED — ${err instanceof Error ? err.message : err}`)
  }

  let assets
  try {
    assets = await fetchReleaseAssets(tag)
  } catch (err) {
    // Previously this just warned and returned 0. That meant any CI flake on
    // the GitHub API (rate limit, 5xx, missing GITHUB_TOKEN on a private repo)
    // produced an installer with no bootstrap-python, with no visible signal.
    // Surface the failure now and treat every requested platform as failed.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`Could not fetch release assets for tag "${tag}": ${message}`)
    for (const platform of platforms) recordFailure(platform, new Error(`release fetch failed: ${message}`))
    exitWithFailures(failures, softFail)
    return
  }

  for (const platform of platforms) {
    const destDir = path.join(outBase, platform)

    // Pre-existing dir: still verify it has the binary we expect. A half-
    // extracted dir from a previous run (e.g. cancelled tar) would otherwise
    // be treated as "already done" and silently ship broken.
    if (fs.existsSync(destDir)) {
      try {
        verifyPlatform(outBase, platform)
        console.log(`  ${platform}: already exists and verified, skipping`)
        continue
      } catch (err) {
        recordFailure(platform, err)
        continue
      }
    }

    const assetName = `bootstrap-python-${platform}.tar.gz`
    const asset = assets.find((a) => a.name === assetName)
    if (!asset) {
      recordFailure(platform, new Error(`asset ${assetName} not found in release ${tag}`))
      continue
    }

    console.log(`  ${platform}: downloading ${assetName} (${(asset.size / 1048576).toFixed(1)} MB)`)
    try {
      // Use asset.url (REST API endpoint) not browser_download_url to
      // support private repos and avoid auth-header issues with S3 redirects.
      await downloadAndExtract(asset.url, destDir)
      verifyPlatform(outBase, platform)
      console.log(`  ${platform}: OK`)
    } catch (err) {
      recordFailure(platform, err)
    }
  }

  exitWithFailures(failures, softFail)
}

function exitWithFailures(failures, softFail) {
  if (failures.length === 0) {
    console.log('Done.')
    return
  }
  console.error('')
  console.error(`bootstrap-python fetch finished with ${failures.length} failure(s):`)
  for (const { platform, message } of failures) {
    console.error(`  - ${platform}: ${message}`)
  }
  if (softFail) {
    console.error('--soft-fail was set: exiting 0 despite failures. Do not use this flag in production builds.')
    return
  }
  console.error('')
  console.error(
    'Refusing to continue. A build that proceeds without bootstrap-python ships an installer that ' +
    'cannot resolve "Latest Stable" on first launch (no git backend), and new installs are stranded ' +
    'on the bundled ComfyUI version with the UI claiming "Already up to date". Fix the fetch (token / ' +
    'network / asset name) or rerun with --soft-fail for local dev only.'
  )
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
