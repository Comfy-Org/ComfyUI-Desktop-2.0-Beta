/**
 * Download pre-built bootstrap-python archives for all platforms.
 *
 * Called before `todesktop build` (or local electron-builder) to ensure
 * the platform-specific bootstrap-python directories exist under
 * bootstrap-python/{win-x64,mac-arm64,linux-x64}/.
 *
 * Usage:
 *   node scripts/fetch-bootstrap-python.mjs [--tag bootstrap-v1]
 *
 * Requires GITHUB_TOKEN env var for authenticated downloads from releases.
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

function parseArgs() {
  const args = process.argv.slice(2)
  let tag = DEFAULT_TAG
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) {
      tag = args[++i]
    }
  }
  return { tag }
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
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpFile))
  execSync(`tar -xzf "${tmpFile}" -C "${path.dirname(destDir)}"`, { stdio: 'inherit' })
  fs.unlinkSync(tmpFile)
}

async function main() {
  const { tag } = parseArgs()
  console.log(`Fetching bootstrap-python archives from release ${tag}`)

  let assets
  try {
    assets = await fetchReleaseAssets(tag)
  } catch (err) {
    console.warn(`Could not fetch release assets: ${err.message}`)
    console.warn('Bootstrap python will not be available. Continuing without it.')
    return
  }

  for (const platform of PLATFORMS) {
    const destDir = path.join(outputBase, platform)
    if (fs.existsSync(destDir)) {
      console.log(`  ${platform}: already exists, skipping`)
      continue
    }

    const assetName = `bootstrap-python-${platform}.tar.gz`
    const asset = assets.find((a) => a.name === assetName)
    if (!asset) {
      console.warn(`  ${platform}: asset ${assetName} not found in release, skipping`)
      continue
    }

    console.log(`  ${platform}: downloading ${assetName} (${(asset.size / 1048576).toFixed(1)} MB)`)
    try {
      // Use asset.url (REST API endpoint) not browser_download_url to
      // support private repos and avoid auth-header issues with S3 redirects.
      await downloadAndExtract(asset.url, destDir)
      console.log(`  ${platform}: OK`)
    } catch (err) {
      console.warn(`  ${platform}: failed - ${err.message}`)
    }
  }

  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
