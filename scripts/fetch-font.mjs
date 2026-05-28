/**
 * Download the proprietary PP Formula font from the private GCS bucket into the
 * renderer public dir, so release builds ship the brand display face.
 *
 * PP Formula (Pangram Pangram) is license-restricted and is NOT committed to
 * this public repo. The renderer references it as a public asset
 * (`/fonts/PPFormula-Extrabold.otf`); when absent the app falls back to Inter.
 *
 * Usage:
 *   node scripts/fetch-font.mjs [--bucket gs://comfy-org-fonts] [--output-dir <dir>] [--soft-fail]
 *
 * Options:
 *   --bucket      Source bucket (default: gs://comfy-org-fonts)
 *   --output-dir  Override output dir (default: src/renderer/public/fonts)
 *   --soft-fail   Exit 0 even if the fetch fails. For LOCAL DEV ONLY — the app
 *                 just falls back to Inter. Production/release builds MUST NOT
 *                 pass this: shipping a release without the licensed display
 *                 face is a regression we want to fail loudly on.
 *
 * Auth: uses Application Default Credentials via the `gcloud` CLI. In CI the
 * google-github-actions/auth step (Workload Identity Federation) provides ADC
 * and setup-gcloud provides the binary. Locally, `gcloud auth login` with a
 * comfy.org account that has read on the bucket.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const DEFAULT_BUCKET = 'gs://comfy-org-fonts'
const DEFAULT_OUTPUT_DIR = path.join(projectRoot, 'src', 'renderer', 'public', 'fonts')

// Files to pull. Keep in sync with the @font-face declarations in
// src/renderer/src/assets/main.css. Only the weights actually referenced are
// fetched, to avoid shipping unused (but still licensed) styles.
const FONT_FILES = ['PPFormula-Extrabold.otf']

function parseArgs() {
  const args = process.argv.slice(2)
  let bucket = DEFAULT_BUCKET
  let outputDir = DEFAULT_OUTPUT_DIR
  let softFail = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bucket' && args[i + 1]) {
      bucket = args[++i]
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      outputDir = args[++i]
    } else if (args[i] === '--soft-fail') {
      softFail = true
    }
  }
  return { bucket, outputDir, softFail }
}

function downloadFile(bucket, file, outputDir) {
  const src = `${bucket.replace(/\/$/, '')}/${file}`
  const dest = path.join(outputDir, file)
  // execFileSync (not execSync) so the bucket/file/dest are passed as argv
  // entries rather than interpolated into a shell string.
  execFileSync('gcloud', ['storage', 'cp', src, dest], { stdio: 'inherit' })
  // A 0 exit from gcloud is not enough — verify the file landed and is
  // non-empty before treating it as success.
  const stat = fs.existsSync(dest) ? fs.statSync(dest) : null
  if (!stat || stat.size === 0) {
    throw new Error(`Expected ${dest} after download, but it is missing or empty.`)
  }
  console.log(`  ${file}: OK (${stat.size} bytes)`)
}

function main() {
  const { bucket, outputDir, softFail } = parseArgs()
  console.log(`Fetching proprietary font(s) from ${bucket}`)
  if (softFail) console.log('  --soft-fail: a failure will be logged but not exit non-zero (dev only)')

  fs.mkdirSync(outputDir, { recursive: true })

  const failures = []
  for (const file of FONT_FILES) {
    try {
      downloadFile(bucket, file, outputDir)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push({ file, message })
      console.error(`  ${file}: FAILED — ${message}`)
    }
  }

  if (failures.length === 0) {
    console.log('Done.')
    return
  }

  console.error('')
  console.error(`Font fetch finished with ${failures.length} failure(s):`)
  for (const { file, message } of failures) {
    console.error(`  - ${file}: ${message}`)
  }

  if (softFail) {
    console.error('--soft-fail set: exiting 0 despite failures. The app will fall back to Inter.')
    return
  }

  console.error('')
  console.error(
    'Refusing to continue. A release build that proceeds without PP Formula ships with the ' +
    'Inter fallback instead of the brand display face. Fix auth (gcloud / Workload Identity), ' +
    'network, or the bucket object name, or rerun with --soft-fail for local dev only.'
  )
  process.exit(1)
}

main()
