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
 * Downloads go through GitHub's public release CDN
 * (https://github.com/<repo>/releases/download/<tag>/<asset>) so they
 * require no authentication and are not subject to REST API rate limits.
 * This is what makes the script work on todesktop's build servers, which
 * have no GITHUB_TOKEN and would otherwise hit the 60 req/hour anonymous
 * API quota.
 *
 * Skips platforms whose directory already exists (after verifying their
 * Python binary is present).
 */

import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'

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

function assetUrl(tag, platform) {
  // Public release CDN URL — no API quota, no auth needed.
  return `https://github.com/${REPO}/releases/download/${tag}/bootstrap-python-${platform}.tar.gz`
}

async function downloadAndExtract(url, destDir) {
  // No Authorization header: this endpoint serves a 302 to a pre-signed S3
  // URL, and sending Bearer auth makes S3 reject the redirected request.
  const response = await fetch(url, { headers: { Accept: 'application/octet-stream' } })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`)
  }

  // Save to temp file first, then extract with the Node `tar` package.
  // The previous shell-out to `tar -xzf` broke on todesktop's Windows
  // builder: its GNU tar parsed the tmpFile's "C:" drive letter as a
  // remote SSH host ("Cannot connect to C: resolve failed"). Node `tar`
  // handles Windows paths natively and removes the dependency on whatever
  // tar binary happens to be in PATH on the build machine.
  fs.mkdirSync(path.dirname(destDir), { recursive: true })
  const tmpFile = `${destDir}.tar.gz`
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmpFile))
    await tar.x({ file: tmpFile, cwd: path.dirname(destDir) })
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

    const url = assetUrl(tag, platform)
    console.log(`  ${platform}: downloading ${url}`)
    try {
      await downloadAndExtract(url, destDir)
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
