#!/usr/bin/env node
/**
 * Build a minimal bootstrap Python environment with pygit2 for Comfy Desktop.
 *
 * Downloads python-build-standalone (stripped), installs pygit2 using the
 * just-extracted interpreter, and aggressively strips unnecessary files to
 * produce a ~50 MB environment that provides git operations via pygit2.
 *
 * No system Python is required to run this script — the downloaded standalone
 * interpreter is used for all Python invocations.
 *
 * Usage:
 *   node build-bootstrap-python.mjs [--output DIR] [--platform PLATFORM]
 *
 * Platforms: win-x64, mac-arm64, linux-x64
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Match the standalone environment versions
const PYTHON_VERSION = '3.13.12'
const PBS_RELEASE = '20260211'

const PLATFORM_MAP = {
  'win-x64': {
    archive: `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`,
    pythonBin: 'python.exe',
  },
  'mac-arm64': {
    archive: `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    pythonBin: path.join('bin', 'python3'),
  },
  'linux-x64': {
    archive: `cpython-${PYTHON_VERSION}+${PBS_RELEASE}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
    pythonBin: path.join('bin', 'python3'),
  },
}

const PBS_URL_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}`

const STRIP_DIRS = new Set([
  'test', 'tests', '__pycache__',
  'idle_test', 'idlelib', 'tkinter', 'turtledemo',
  'ensurepip', 'venv',
  'lib2to3', 'pydoc_data',
  'unittest',
  'tcl', 'tk',
  'libs',
])

const STRIP_TOP_LEVEL = [
  /^pip$/i, /^pip-.*/i, /^setuptools$/i, /^setuptools-.*/i,
  /^_distutils_hack$/i, /^distutils$/i,
  /^pkg_resources$/i,
]

const STRIP_EXTENSIONS = ['.pyc', '.pyo', '.a', '.lib']

const STRIP_FILES = new Set([
  'tcl86t.dll', 'tk86t.dll', 'sqlite3.dll',
  '_testcapi.pyd', '_tkinter.pyd', '_sqlite3.pyd',
])

function detectPlatform() {
  const sys = process.platform
  if (sys === 'win32') return 'win-x64'
  if (sys === 'darwin') return 'mac-arm64'
  if (sys === 'linux') return 'linux-x64'
  throw new Error(`Unsupported platform: ${sys} ${process.arch}`)
}

function parseArgs(argv) {
  const args = { output: 'bootstrap-python', platform: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--output') args.output = argv[++i]
    else if (a === '--platform') args.platform = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node build-bootstrap-python.mjs [--output DIR] [--platform PLATFORM]')
      process.exit(0)
    }
  }
  return args
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  const stat = await fs.stat(dest)
  console.log(`  -> ${(stat.size / 1048576).toFixed(1)} MB`)
}

function extractTarGz(archivePath, destDir) {
  // tar.exe ships with Windows 10+; use it on all platforms for portability.
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tar extraction failed (status ${result.status})`)
}

async function findSitePackages(envDir) {
  // Windows-style layout (Lib/site-packages)
  const winSp = path.join(envDir, 'Lib', 'site-packages')
  if (await isDir(winSp)) return winSp
  // Unix-style layout (lib/python3.X/site-packages)
  const libDir = path.join(envDir, 'lib')
  if (await isDir(libDir)) {
    for (const entry of await fs.readdir(libDir)) {
      if (entry.startsWith('python')) {
        const sp = path.join(libDir, entry, 'site-packages')
        if (await isDir(sp)) return sp
      }
    }
  }
  return null
}

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

async function isFile(p) {
  try { return (await fs.stat(p)).isFile() } catch { return false }
}

async function stripEnvironment(envDir) {
  let removed = 0

  // Remove directories by name anywhere in the tree (bottom-up)
  async function walkDirsBottomUp(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (STRIP_DIRS.has(e.name)) {
          await fs.rm(full, { recursive: true, force: true })
          removed++
        } else {
          await walkDirsBottomUp(full)
        }
      }
    }
  }
  await walkDirsBottomUp(envDir)

  // Remove specific top-level packages from site-packages
  const sitePackages = await findSitePackages(envDir)
  if (sitePackages) {
    for (const entry of await fs.readdir(sitePackages)) {
      if (STRIP_TOP_LEVEL.some((re) => re.test(entry))) {
        await fs.rm(path.join(sitePackages, entry), { recursive: true, force: true })
        removed++
      }
    }
  }

  // Remove files by extension and by name
  async function walkFiles(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walkFiles(full)
      } else if (e.isFile()) {
        if (STRIP_EXTENSIONS.some((ext) => e.name.endsWith(ext)) || STRIP_FILES.has(e.name)) {
          await fs.unlink(full)
          removed++
        }
      }
    }
  }
  await walkFiles(envDir)

  // Remove share/ and include/ directories at top level
  for (const sub of ['share', 'include']) {
    const full = path.join(envDir, sub)
    if (await isDir(full)) {
      await fs.rm(full, { recursive: true, force: true })
      removed++
    }
  }

  console.log(`  Stripped ${removed} items`)
}

async function getDirSizeMb(p) {
  let total = 0
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile()) total += (await fs.stat(full)).size
    }
  }
  await walk(p)
  return total / 1048576
}

function runPython(pythonPath, args, opts = {}) {
  const result = spawnSync(pythonPath, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw result.error
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const plat = args.platform || detectPlatform()
  const platInfo = PLATFORM_MAP[plat]
  if (!platInfo) throw new Error(`Unknown platform: ${plat}`)
  const outputDir = path.join(args.output, plat)

  console.log(`Building bootstrap Python for ${plat}`)
  console.log(`  Python ${PYTHON_VERSION}, PBS release ${PBS_RELEASE}`)

  // Clean output
  if (await isDir(outputDir)) await fs.rm(outputDir, { recursive: true, force: true })

  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap-py-'))
  try {
    const archivePath = path.join(tmpdir, platInfo.archive)
    await downloadFile(`${PBS_URL_BASE}/${platInfo.archive}`, archivePath)

    console.log('Extracting...')
    extractTarGz(archivePath, tmpdir)

    const extracted = path.join(tmpdir, 'python')
    if (!(await isDir(extracted))) {
      throw new Error(`Expected 'python/' directory in archive, not found in ${tmpdir}`)
    }

    const pythonPath = path.join(extracted, platInfo.pythonBin)

    if (plat !== 'win-x64') {
      await fs.chmod(pythonPath, 0o755)
    }

    console.log('Installing pygit2...')
    const installRes = runPython(pythonPath, ['-m', 'pip', 'install', '--no-cache-dir', 'pygit2'])
    if (installRes.status !== 0) throw new Error('pip install pygit2 failed')

    const verifyRes = runPython(pythonPath, ['-c', "import pygit2; print(f'pygit2 {pygit2.__version__}')"], { capture: true })
    if (verifyRes.status !== 0) {
      console.error(`ERROR: pygit2 import failed: ${verifyRes.stderr}`)
      process.exit(1)
    }
    console.log(`  ${verifyRes.stdout.trim()}`)

    console.log('Stripping unnecessary files...')
    const preSize = await getDirSizeMb(extracted)
    await stripEnvironment(extracted)
    const postSize = await getDirSizeMb(extracted)
    console.log(`  ${preSize.toFixed(1)} MB -> ${postSize.toFixed(1)} MB`)

    const verifyRes2 = runPython(pythonPath, ['-c', "import pygit2; print('OK')"], { capture: true })
    if (verifyRes2.status !== 0) {
      console.error(`ERROR: pygit2 broken after stripping: ${verifyRes2.stderr}`)
      process.exit(1)
    }

    await fs.mkdir(path.dirname(outputDir), { recursive: true })
    await fs.rename(extracted, outputDir).catch(async (err) => {
      // Cross-device rename can fail; fall back to copy.
      if (err.code === 'EXDEV') {
        await fs.cp(extracted, outputDir, { recursive: true })
      } else {
        throw err
      }
    })

    console.log(`\nBootstrap Python ready: ${outputDir} (${(await getDirSizeMb(outputDir)).toFixed(1)} MB)`)
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
