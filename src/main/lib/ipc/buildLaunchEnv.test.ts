import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en',
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
}))

const settingsState: Record<string, unknown> = {}
vi.mock('../../settings', () => ({
  get: (key: string) => settingsState[key],
  set: (key: string, value: unknown) => {
    settingsState[key] = value
  },
}))

import * as settingsModule from '../../settings'
import type { InstallationRecord } from '../../installations'
import { buildLaunchEnv } from './shared'

function fakeInst(sourceId: InstallationRecord['sourceId'] = 'standalone'): InstallationRecord {
  return { sourceId } as InstallationRecord
}

describe('buildLaunchEnv mirror injection', () => {
  let originalHfEndpoint: string | undefined

  beforeEach(() => {
    originalHfEndpoint = process.env.HF_ENDPOINT
    delete process.env.HF_ENDPOINT
    for (const k of Object.keys(settingsState)) delete settingsState[k]
  })

  afterEach(() => {
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT
    else process.env.HF_ENDPOINT = originalHfEndpoint
  })

  it('omits HF_ENDPOINT when mirrors are off', () => {
    settingsModule.set('useChineseMirrors', false)
    const env = buildLaunchEnv(fakeInst())
    expect(env.HF_ENDPOINT).toBeUndefined()
  })

  it('omits HF_ENDPOINT when the setting is unset', () => {
    const env = buildLaunchEnv(fakeInst())
    expect(env.HF_ENDPOINT).toBeUndefined()
  })

  it('injects the HF mirror when mirrors are on and no user override exists', () => {
    settingsModule.set('useChineseMirrors', true)
    const env = buildLaunchEnv(fakeInst())
    expect(env.HF_ENDPOINT).toBe('https://hf-mirror.com')
  })

  it('respects a user-provided HF_ENDPOINT and does not override it', () => {
    settingsModule.set('useChineseMirrors', true)
    process.env.HF_ENDPOINT = 'https://my-private-hf.example.com'
    const env = buildLaunchEnv(fakeInst())
    expect(env.HF_ENDPOINT).toBe('https://my-private-hf.example.com')
  })

  it('keeps other env keys untouched alongside the mirror', () => {
    settingsModule.set('useChineseMirrors', true)
    const env = buildLaunchEnv(fakeInst())
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.CM_USE_PYGIT2).toBe('1')
  })
})
