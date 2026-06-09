import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Drive-aware default helpers in paths.ts. The drive-redirect branch only
// activates on Windows (NSIS lets the user pick an install drive); on other
// platforms the helpers fall back to the home dir.

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

  it('falls back to home when the app is on the same drive as home (win32)', async () => {
    stubPlatform('win32')
    // Home parsed by win32 has no drive root here, so emulate a real same-drive
    // case by putting both on C:.
    exePath = 'C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe'
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: {
        getPath: (name: string) => {
          if (name === 'home') return 'C:\\Users\\test'
          if (name === 'exe') return exePath
          return 'C:\\Users\\test'
        },
      },
    }))
    const p = await import('./paths')

    expect(p.defaultDataRoot()).toBe('C:\\Users\\test')
    expect(p.builtinDefaultInstallDir()).toBe(path.join('C:\\Users\\test', 'ComfyUI-Installs'))
  })

  it('never redirects on non-Windows platforms', async () => {
    stubPlatform('linux')
    exePath = '/opt/Comfy Desktop/comfy-desktop'
    const p = await loadPaths()

    expect(p.defaultDataRoot()).toBe(HOME)
    expect(p.builtinDefaultInstallDir()).toBe(path.join(HOME, 'ComfyUI-Installs'))
  })
})
