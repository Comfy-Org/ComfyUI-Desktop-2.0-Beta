const PLATFORM_MAP = {
  'win32-x64': 'win-x64',
  'darwin-arm64': 'mac-arm64',
  'linux-x64': 'linux-x64',
}

module.exports = async ({ appDir, platform, arch }) => {
  const { execSync } = await import('node:child_process')
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
  execSync(
    `node "${script}" --platform ${bootstrapPlatform} --output-dir "${outDir}"`,
    { stdio: 'inherit', cwd: appDir }
  )
}
