import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive-aware default helpers in paths.ts. The drive-redirect and
// system-drive branches only activate on Windows; on other platforms the
// helpers fall back to the home dir.

const HOME = path.join('/mock', 'home')

let exePath = ''

beforeEach(() => {
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'home') return HOME
        if (name === 'exe') return exePath
        return HOME // userData fallback (unused by these helpers on win)
      },
    },
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('electron')
})

async function loadPaths() {
  return await import('./paths')
}

function stubPlatform(platform: NodeJS.Platform): void {
  vi.stubGlobal('process', { ...process, platform })
}

describe('drive-aware defaults', () => {
  it('redirects data dirs to the app drive when the app is on a non-home drive (win32)', async () => {
    stubPlatform('win32')
    exePath = 'D:\\Programs\\Comfy Desktop\\Comfy Desktop.exe'
    const p = await loadPaths()

    const dataRoot = path.join('D:\\', 'Comfy-Desktop')
    expect(p.defaultDataRoot()).toBe(dataRoot)
    expect(p.builtinDefaultInstallDir()).toBe(path.join(dataRoot, 'ComfyUI-Installs'))
    expect(p.defaultDownloadCacheDir()).toBe(path.join(dataRoot, 'ComfyUI-Cache', 'download-cache'))
  })

  it('never redirects on non-Windows platforms', async () => {
    stubPlatform('linux')
    exePath = '/opt/Comfy Desktop/comfy-desktop'
    const p = await loadPaths()

    expect(p.defaultDataRoot()).toBe(HOME)
    expect(p.builtinDefaultInstallDir()).toBe(path.join(HOME, 'ComfyUI-Installs'))
  })
})

describe('windows system-drive defaults', () => {
  // Real temp dirs (the repo convention) for the home footprint and the marker
  // location, so selectedInstallDrive() sees a same-drive install and the
  // classifier reads genuine on-disk state.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-desktop-2-paths-'))
  const driveRoot = path.win32.parse(tmpRoot).root // same drive as home → system-drive case
  const LOCAL = path.join(tmpRoot, 'AppData', 'Local')
  let homeDir = ''
  let userDataDir = ''
  let prevLocalAppData: string | undefined

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(tmpRoot, 'home-'))
    userDataDir = fs.mkdtempSync(path.join(tmpRoot, 'userdata-'))
    exePath = path.join(driveRoot, 'Program Files', 'Comfy Desktop', 'Comfy Desktop.exe')
    prevLocalAppData = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = LOCAL
    vi.stubGlobal('process', { ...process, platform: 'win32' })

    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        getPath: (name: string) => {
          if (name === 'home') return homeDir
          if (name === 'exe') return exePath
          return userDataDir // userData → marker location
        },
      },
    }))
  })

  afterEach(() => {
    if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = prevLocalAppData
  })

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeMarker(mode: string): void {
    fs.writeFileSync(path.join(userDataDir, 'data-location.json'), JSON.stringify({ mode }), 'utf-8')
  }

  it('new install (no footprint) groups under %LOCALAPPDATA%\\Comfy-Desktop', async () => {
    const p = await import('./paths')

    const root = path.join(LOCAL, 'Comfy-Desktop')
    expect(p.defaultDataRoot()).toBe(root)
    expect(p.builtinDefaultInstallDir()).toBe(path.join(root, 'ComfyUI-Installs'))
    expect(p.defaultDownloadCacheDir()).toBe(path.join(root, 'ComfyUI-Cache', 'download-cache'))
  })

  it('existing install (home footprint) keeps home root and roaming cache', async () => {
    fs.mkdirSync(path.join(homeDir, 'ComfyUI-Installs'), { recursive: true })
    const p = await import('./paths')

    expect(p.defaultDataRoot()).toBe(homeDir)
    expect(p.builtinDefaultInstallDir()).toBe(path.join(homeDir, 'ComfyUI-Installs'))
    // Roaming userData/download-cache, not the grouped Comfy-Desktop cache.
    expect(p.defaultDownloadCacheDir()).toBe(path.join(userDataDir, 'download-cache'))
  })

  it('a local-appdata marker wins even when legacy folders later appear', async () => {
    writeMarker('local-appdata')
    fs.mkdirSync(path.join(homeDir, 'ComfyUI-Shared'), { recursive: true })
    const p = await import('./paths')

    expect(p.defaultDataRoot()).toBe(path.join(LOCAL, 'Comfy-Desktop'))
  })

  it('a legacy-home marker wins even when no legacy footprint exists', async () => {
    writeMarker('legacy-home')
    const p = await import('./paths')

    expect(p.defaultDataRoot()).toBe(homeDir)
  })

  it('persistWinDataRootChoice writes the classified mode once', async () => {
    const p = await import('./paths')

    const markerPath = path.join(userDataDir, 'data-location.json')
    expect(fs.existsSync(markerPath)).toBe(false)
    p.persistWinDataRootChoice()
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf-8'))).toEqual({ mode: 'local-appdata' })

    // A second call must not overwrite the first decision.
    fs.mkdirSync(path.join(homeDir, 'ComfyUI-Installs'), { recursive: true })
    p.persistWinDataRootChoice()
    expect(JSON.parse(fs.readFileSync(markerPath, 'utf-8'))).toEqual({ mode: 'local-appdata' })
  })
})
