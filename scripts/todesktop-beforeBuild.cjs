// Keys are todesktop's normalized `${platform}-${arch}` strings (matches
// electron-builder's Platform enum: windows / mac / linux), NOT Node's
// process.platform values (win32 / darwin / linux). Until this was fixed,
// every Windows and Mac build silently hit the "skipping" branch below —
// the fetch on todesktop's server never ran, which is why 0.6.4 (and every
// earlier release with this hook) shipped without bootstrap-python.
const PLATFORM_MAP = {
  'windows-x64': 'win-x64',
  'windows-arm64': 'win-x64', // Windows-on-ARM runs x64 under emulation
  'mac-arm64': 'mac-arm64',
  'linux-x64': 'linux-x64',
}

// Each platform's expected Python binary inside its bootstrap-python dir.
// Mirrors PYTHON_BINARY in fetch-bootstrap-python.mjs and the runtime check
// in src/main/lib/git.ts:tryConfigureBootstrapPygit2. Kept here so a fetch
// script that returns 0 but produces a directory without the binary still
// fails the build instead of silently shipping a broken installer.
// Forward slashes are fine on every platform — these strings are passed to
// path.join() below, which normalizes separators per-OS.
const PYTHON_BINARY = {
  'win-x64': 'python.exe',
  'mac-arm64': 'bin/python3',
  'linux-x64': 'bin/python3',
}

// Mirrors UV_BINARY in fetch-bootstrap-python.mjs and uvDestRel in
// build-bootstrap-python.mjs. Verified here too so that a fetch returning
// success without uv (e.g. accidentally re-tagging a pre-v2 archive at the
// current default tag) fails the build instead of shipping a launcher whose
// adopted-install flows have no usable package manager.
const UV_BINARY = {
  'win-x64': 'uv.exe',
  'mac-arm64': 'bin/uv',
  'linux-x64': 'bin/uv',
}

// MUI2 installer artwork that scripts/installer.nsh references via
// `${BUILD_RESOURCES_DIR}\<name>.bmp`. Local electron-builder builds work
// because electron-builder.yml sets `directories.buildResources: resources`,
// so BUILD_RESOURCES_DIR resolves to ./resources/ and finds the files there.
// ToDesktop bypasses electron-builder.yml entirely and uses its own
// `<workingDir>/build/` for BUILD_RESOURCES_DIR (see the build log:
// `BUILD_RESOURCES_DIR=...\todesktop\<id>\build`), so MUI_HEADERIMAGE_INIT
// fails at NSIS compile time with "no files found." Stage the BMPs into
// ToDesktop's build dir from the unpacked source archive so the macro
// resolves. No-op on macOS / Linux (the windows installer.nsh include is
// only consumed by the win NSIS target).
const INSTALLER_ART = ['installerHeader.bmp', 'installerSidebar.bmp', 'uninstallerSidebar.bmp']

module.exports = async ({ appDir, platform, arch }) => {
  const { execSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const path = await import('node:path')

  // Stage installer BMPs FIRST so a bootstrap-python skip / failure doesn't
  // mask the windows installer issue. Only runs when there's something to
  // copy AND we're on a windows build.
  if (platform === 'windows') {
    // Hook contract: appDir = <workingDir>/app-wrapper/app (see the comment
    // on the bootstrap-python outDir below). build/ sits at workingDir level.
    const buildDir = path.join(appDir, '..', '..', 'build')
    fs.mkdirSync(buildDir, { recursive: true })
    for (const name of INSTALLER_ART) {
      const src = path.join(appDir, 'resources', name)
      const dst = path.join(buildDir, name)
      if (!fs.existsSync(src)) {
        // Fail loudly. A silent skip here is what shipped the broken build —
        // NSIS compile-time errors look unrelated to a beforeBuild no-op.
        throw new Error(
          `[todesktop:beforeBuild] Missing installer artwork: ${src}. ` +
          `scripts/installer.nsh references this via \${BUILD_RESOURCES_DIR}\\${name}; ` +
          `without it, MUI_HEADERIMAGE_INIT fails the windows build at NSIS compile time.`
        )
      }
      fs.copyFileSync(src, dst)
      console.log(`[todesktop:beforeBuild] Staged ${name} -> ${dst}`)
    }
  }

  const key = `${platform}-${arch}`
  const bootstrapPlatform = PLATFORM_MAP[key]
  if (!bootstrapPlatform) {
    console.log(`[todesktop:beforeBuild] No bootstrap python for ${key}, skipping`)
    return
  }

  console.log(`[todesktop:beforeBuild] Fetching bootstrap python for ${bootstrapPlatform}`)
  const script = path.join(appDir, 'scripts', 'fetch-bootstrap-python.mjs')
  // todesktop layout:
  //   <workingDir>/app-wrapper/app/         <- this is `appDir` (electron-builder appDirectory)
  //   <workingDir>/app-wrapper/extraResources/  <- where extraResources.from is staged from
  // extraResources.from in todesktop.json resolves against `app-wrapper/extraResources/`,
  // NOT against the project root. The v0.6.6 mac build log proved this: the hook
  // verified the binary inside `app-wrapper/app/extraResources/...` (correct relative
  // to `appDir`) but electron-builder still warned `file source doesn't exist
  // from=app-wrapper/extraResources/...` — and the dmg shipped without bootstrap-python.
  // Going up one level from `appDir` puts the archive where todesktop actually reads it.
  const outDir = path.join(appDir, '..', 'extraResources', 'bootstrap-python')
  // fetch-bootstrap-python.mjs now exits non-zero on failure, which bubbles
  // up here via execSync. Don't wrap in try/catch — a failed fetch must fail
  // the build (see 0.6.4 post-mortem: a swallowed fetch error shipped an
  // installer with no bootstrap-python, stranding new installs).
  execSync(
    `node "${script}" --platform ${bootstrapPlatform} --output-dir "${outDir}"`,
    { stdio: 'inherit', cwd: appDir }
  )

  // Defense-in-depth: even if the fetch script returns success, verify the
  // expected binaries exist before handing control back to todesktop. A
  // divergence between the fetch script's success criteria and what the app
  // looks for at runtime would otherwise reproduce the same silent failure.
  const expectedPython = path.join(outDir, bootstrapPlatform, PYTHON_BINARY[bootstrapPlatform])
  if (!fs.existsSync(expectedPython)) {
    throw new Error(
      `[todesktop:beforeBuild] fetch script returned success but ${expectedPython} is missing. ` +
      `Refusing to build — the installer would not provide a git backend and "Latest Stable" ` +
      `installs would silently strand on the bundled ComfyUI version.`
    )
  }
  const expectedUv = path.join(outDir, bootstrapPlatform, UV_BINARY[bootstrapPlatform])
  if (!fs.existsSync(expectedUv)) {
    throw new Error(
      `[todesktop:beforeBuild] fetch script returned success but ${expectedUv} is missing. ` +
      `Refusing to build — the bootstrap archive predates bootstrap-v2 (no bundled uv). ` +
      `Bump the default tag in fetch-bootstrap-python.mjs or publish the v2 archives.`
    )
  }
  console.log(`[todesktop:beforeBuild] Verified ${expectedPython} and ${expectedUv}`)
}
