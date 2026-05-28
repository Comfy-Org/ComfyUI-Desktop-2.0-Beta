const PLATFORM_MAP = {
  'win32-x64': 'win-x64',
  'darwin-arm64': 'mac-arm64',
  'linux-x64': 'linux-x64',
}

// Each platform's expected Python binary inside its bootstrap-python dir.
// Mirrors PYTHON_BINARY in fetch-bootstrap-python.mjs and the runtime check
// in src/main/lib/git.ts:tryConfigureBootstrapPygit2. Kept here so a fetch
// script that returns 0 but produces a directory without the binary still
// fails the build instead of silently shipping a broken installer.
const PYTHON_BINARY = {
  'win-x64': 'python.exe',
  'mac-arm64': require('node:path').join('bin', 'python3'),
  'linux-x64': require('node:path').join('bin', 'python3'),
}

module.exports = async ({ appDir, platform, arch }) => {
  const { execSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')

  const key = `${platform}-${arch}`
  const bootstrapPlatform = PLATFORM_MAP[key]
  if (!bootstrapPlatform) {
    console.log(`[todesktop:beforeBuild] No bootstrap python for ${key}, skipping`)
    return
  }

  console.log(`[todesktop:beforeBuild] Fetching bootstrap python for ${bootstrapPlatform}`)
  const script = path.join(appDir, 'scripts', 'fetch-bootstrap-python.mjs')
  const outDir = path.join(appDir, 'bootstrap-python')
  // fetch-bootstrap-python.mjs now exits non-zero on failure, which bubbles
  // up here via execSync. Don't wrap in try/catch — a failed fetch must fail
  // the build (see 0.6.4 post-mortem: a swallowed fetch error shipped an
  // installer with no bootstrap-python, stranding new installs).
  execSync(
    `node "${script}" --platform ${bootstrapPlatform} --output-dir "${outDir}"`,
    { stdio: 'inherit', cwd: appDir }
  )

  // Defense-in-depth: even if the fetch script returns success, verify the
  // expected binary exists before handing control back to todesktop. A
  // divergence between the fetch script's success criteria and what the app
  // looks for at runtime would otherwise reproduce the same silent failure.
  const expectedBinary = path.join(outDir, bootstrapPlatform, PYTHON_BINARY[bootstrapPlatform])
  if (!fs.existsSync(expectedBinary)) {
    throw new Error(
      `[todesktop:beforeBuild] fetch script returned success but ${expectedBinary} is missing. ` +
      `Refusing to build — the installer would not provide a git backend and "Latest Stable" ` +
      `installs would silently strand on the bundled ComfyUI version.`
    )
  }
  console.log(`[todesktop:beforeBuild] Verified ${expectedBinary}`)
}
