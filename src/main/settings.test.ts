import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'comfyui-desktop-2-settings-'))
const homePath = path.join(tmpRoot, 'home')
const userDataPath = path.join(homePath, 'AppData', 'Roaming', 'comfyui-desktop-2')
const adminHomePath = path.join(tmpRoot, 'Administrator')
const adminUserDataPath = path.join(adminHomePath, 'AppData', 'Roaming', 'comfyui-desktop-2')
const xdgConfigHome = path.join(homePath, '.config')
const xdgCacheHome = path.join(homePath, '.cache')
const adminXdgCacheHome = path.join(adminHomePath, '.cache')
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalXdgCacheHome = process.env.XDG_CACHE_HOME

process.env.XDG_CONFIG_HOME = xdgConfigHome
process.env.XDG_CACHE_HOME = xdgCacheHome
fs.mkdirSync(homePath, { recursive: true })
fs.mkdirSync(userDataPath, { recursive: true })
fs.mkdirSync(adminHomePath, { recursive: true })
fs.mkdirSync(adminUserDataPath, { recursive: true })
fs.mkdirSync(xdgConfigHome, { recursive: true })
fs.mkdirSync(xdgCacheHome, { recursive: true })

let settings: {
  set: (key: string, value: unknown) => void
  get: (key: string) => unknown
  has: (key: string) => boolean
  defaults: { onAppClose: 'tray' | 'quit' }
}

const settingsPath = process.platform === 'linux'
  ? path.join(xdgConfigHome, 'comfyui-desktop-2', 'settings.json')
  : path.join(userDataPath, 'settings.json')
const expectedCacheDir = process.platform === 'linux'
  ? path.join(xdgCacheHome, 'comfyui-desktop-2', 'download-cache')
  : path.join(userDataPath, 'download-cache')
const copiedAdminCacheDir = process.platform === 'linux'
  ? path.join(adminXdgCacheHome, 'comfyui-desktop-2', 'download-cache')
  : path.join(adminUserDataPath, 'download-cache')
const shouldRewriteCopiedDefaults = process.platform === 'win32'

function readPersistedSettings(): Record<string, unknown> {
  const raw = fs.readFileSync(settingsPath, 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

beforeEach(async () => {
  fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true })
  vi.resetModules()
  vi.doMock('electron', () => ({
    app: {
      getPath: (name: string) => {
        if (name === 'home') return homePath
        return userDataPath
      },
    },
  }))
  settings = await import('./settings')
})

afterAll(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('settings unset/default semantics', () => {
  it('treats undefined as unset and falls back to default', () => {
    settings.set('onAppClose', 'quit')
    expect(settings.get('onAppClose')).toBe('quit')

    settings.set('onAppClose', undefined)

    expect(settings.get('onAppClose')).toBe(settings.defaults.onAppClose)
    const persisted = readPersistedSettings()
    expect(persisted).not.toHaveProperty('onAppClose')
  })

  it('normalizes legacy null values to unset on write', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ autoUpdate: null }, null, 2),
      'utf-8'
    )

    expect(settings.get('autoUpdate')).toBeUndefined()

    settings.set('theme', 'dark')

    const persisted = readPersistedSettings()
    expect(persisted).not.toHaveProperty('autoUpdate')
    expect(persisted['theme']).toBe('dark')
  })

  it('drops the legacy primaryInstallId and pinnedInstallIds keys on load', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          primaryInstallId: 'inst-1',
          pinnedInstallIds: ['inst-2', 'inst-3'],
          theme: 'dark',
        },
        null,
        2
      ),
      'utf-8'
    )

    expect(settings.get('primaryInstallId' as string)).toBeUndefined()
    expect(settings.get('pinnedInstallIds' as string)).toBeUndefined()
    expect(settings.get('theme')).toBe('dark')

    const persisted = readPersistedSettings()
    expect(persisted).not.toHaveProperty('primaryInstallId')
    expect(persisted).not.toHaveProperty('pinnedInstallIds')
    expect(persisted['theme']).toBe('dark')
  })

  it('treats null for unknown keys as passthrough values', () => {
    settings.set('customKey' as string, null)
    expect(settings.get('customKey' as string)).toBeNull()
    expect(readPersistedSettings()['customKey']).toBeNull()
  })

  it('treats empty and whitespace-only strings as unset for pypiMirror', () => {
    settings.set('pypiMirror', 'https://mirrors.aliyun.com/pypi/simple/')
    expect(settings.get('pypiMirror')).toBe('https://mirrors.aliyun.com/pypi/simple/')

    settings.set('pypiMirror', '')
    expect(settings.get('pypiMirror')).toBeUndefined()
    expect(readPersistedSettings()).not.toHaveProperty('pypiMirror')

    settings.set('pypiMirror', 'https://example.com/simple/')
    settings.set('pypiMirror', '   ')
    expect(settings.get('pypiMirror')).toBeUndefined()
    expect(readPersistedSettings()).not.toHaveProperty('pypiMirror')
  })
})

describe('settings path sanitization', () => {
  it('rewrites copied foreign-user defaults on Windows only', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const customModelsDir = path.join(tmpRoot, 'custom-models')
    const expectedModelsDirs = shouldRewriteCopiedDefaults
      ? [
          customModelsDir,
          path.join(homePath, 'ComfyUI-Shared', 'models'),
        ]
      : [
          path.join(adminHomePath, 'ComfyUI-Shared', 'models'),
          customModelsDir,
          path.join(homePath, 'ComfyUI-Shared', 'models'),
        ]
    const expectedInputDir = shouldRewriteCopiedDefaults
      ? path.join(homePath, 'ComfyUI-Shared', 'input')
      : path.join(adminHomePath, 'ComfyUI-Shared', 'input')
    const expectedOutputDir = shouldRewriteCopiedDefaults
      ? path.join(homePath, 'ComfyUI-Shared', 'output')
      : path.join(adminHomePath, 'ComfyUI-Shared', 'output')
    const expectedPersistedCacheDir = shouldRewriteCopiedDefaults
      ? expectedCacheDir
      : copiedAdminCacheDir
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        cacheDir: copiedAdminCacheDir,
        modelsDirs: [
          path.join(adminHomePath, 'ComfyUI-Shared', 'models'),
          customModelsDir,
        ],
        inputDir: path.join(adminHomePath, 'ComfyUI-Shared', 'input'),
        outputDir: path.join(adminHomePath, 'ComfyUI-Shared', 'output'),
      }, null, 2),
      'utf-8'
    )

    expect(settings.get('cacheDir')).toBe(expectedPersistedCacheDir)
    expect(settings.get('modelsDirs')).toEqual(expectedModelsDirs)
    expect(settings.get('inputDir')).toBe(expectedInputDir)
    expect(settings.get('outputDir')).toBe(expectedOutputDir)

    const persisted = readPersistedSettings()
    expect(persisted['cacheDir']).toBe(expectedPersistedCacheDir)
    expect(persisted['modelsDirs']).toEqual(expectedModelsDirs)
    expect(persisted['inputDir']).toBe(expectedInputDir)
    expect(persisted['outputDir']).toBe(expectedOutputDir)
  })
})

describe('settings.has (persisted-only check)', () => {
  it('returns false when settings.json does not exist yet', () => {
    expect(settings.has('theme')).toBe(false)
    // Built-in defaults must NOT register as user choices — that's the
    // bug `has()` exists to avoid. `inputDir` has a default value from
    // `settings.defaults` and would show up in `getAll()`, but the file
    // doesn't carry it.
    expect(settings.has('inputDir')).toBe(false)
  })

  it('returns false for keys with defaults even after first load creates settings.json', () => {
    // Touch a key to force a write of settings.json so the file exists
    // but doesn't carry the defaulted keys.
    settings.set('theme', 'dark')
    expect(fs.existsSync(settingsPath)).toBe(true)
    expect(settings.has('theme')).toBe(true)
    // Built-in defaults must still NOT be marked as persisted.
    expect(settings.has('inputDir')).toBe(false)
    expect(settings.has('cacheDir')).toBe(false)
  })

  it('returns true once the user explicitly sets the key', () => {
    settings.set('theme', 'dark')
    expect(settings.has('theme')).toBe(true)
  })

  it('returns false after the key is unset', () => {
    settings.set('theme', 'dark')
    expect(settings.has('theme')).toBe(true)
    settings.set('theme', undefined)
    expect(settings.has('theme')).toBe(false)
  })

  it('returns false for null persisted values', () => {
    // legacy null normalization: any null on disk is treated as unset.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: null }), 'utf-8')
    expect(settings.has('theme')).toBe(false)
  })
})

describe('modelsDirs user ordering', () => {
  it('preserves user-chosen primary models path across restarts', () => {
    const userPrimary = path.join(tmpRoot, 'D-drive-models')
    const systemDefault = path.join(homePath, 'ComfyUI-Shared', 'models')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ modelsDirs: [userPrimary, systemDefault] }, null, 2),
      'utf-8'
    )

    expect(settings.get('modelsDirs')).toEqual([userPrimary, systemDefault])
    expect((settings.get('modelsDirs') as string[])[0]).toBe(userPrimary)
  })

  it('appends system default when missing from user list', () => {
    const userDir = path.join(tmpRoot, 'only-my-models')
    const systemDefault = path.join(homePath, 'ComfyUI-Shared', 'models')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ modelsDirs: [userDir] }, null, 2),
      'utf-8'
    )

    const dirs = settings.get('modelsDirs') as string[]
    expect(dirs).toEqual([userDir, systemDefault])
    expect(dirs[0]).toBe(userDir)
  })

  it('injects system default when modelsDirs is empty', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ modelsDirs: [] }, null, 2),
      'utf-8'
    )

    const dirs = settings.get('modelsDirs') as string[]
    expect(dirs.length).toBe(1)
    expect(path.resolve(dirs[0]!)).toBe(path.join(homePath, 'ComfyUI-Shared', 'models'))
  })
})
