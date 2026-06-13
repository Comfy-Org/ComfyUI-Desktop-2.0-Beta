import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `resolveTemplateModels` loads the template JSON from site-packages (fs) then
// falls back to a remote fetch. Stub both so the loader returns our crafted doc,
// letting us assert the URL whitelist + path-traversal guards end-to-end.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userdata' },
  ipcMain: { handle: vi.fn() },
}))

const fetchJSON = vi.fn()
vi.mock('../../lib/fetch', () => ({ fetchJSON: (...a: unknown[]) => fetchJSON(...a) }))
vi.mock('fs', () => ({
  default: { promises: { readFile: vi.fn().mockRejectedValue(new Error('ENOENT')) } },
}))
vi.mock('../../lib/pythonEnv', () => ({ getActiveVenvDir: () => null }))
vi.mock('./envPaths', async (importOriginal) => ({
  ...(await importOriginal<typeof EnvPaths>()),
  findSitePackages: () => null,
}))

import { sanitizeModelPath, resolveTemplateModels } from './templateModels'
import type * as EnvPaths from './envPaths'
import type { InstallationRecord } from '../../installations'

const inst = { id: 'i1', bundledTemplateId: 't' } as unknown as InstallationRecord

const model = (over: Record<string, unknown>) => ({
  name: 'm.safetensors',
  url: 'https://huggingface.co/x/m.safetensors',
  directory: 'checkpoints',
  ...over,
})

describe('sanitizeModelPath', () => {
  it('accepts a clean relative dir + bare filename', () => {
    expect(sanitizeModelPath('checkpoints', 'm.safetensors')).toEqual({
      directory: 'checkpoints',
      filename: 'm.safetensors',
    })
  })

  it('normalizes backslashes and nested clean dirs', () => {
    expect(sanitizeModelPath('models\\loras', 'm.safetensors')).toEqual({
      directory: 'models/loras',
      filename: 'm.safetensors',
    })
  })

  it('rejects a traversing directory', () => {
    expect(sanitizeModelPath('../etc', 'm.safetensors')).toBeNull()
    expect(sanitizeModelPath('a/../../b', 'm.safetensors')).toBeNull()
    expect(sanitizeModelPath('..', 'm.safetensors')).toBeNull()
  })

  it('rejects an absolute directory', () => {
    expect(sanitizeModelPath('/abs', 'm.safetensors')).toBeNull()
  })

  it('rejects a filename with separators or traversal', () => {
    expect(sanitizeModelPath('checkpoints', '../m.safetensors')).toBeNull()
    expect(sanitizeModelPath('checkpoints', 'sub/m.safetensors')).toBeNull()
    expect(sanitizeModelPath('checkpoints', 'sub\\m.safetensors')).toBeNull()
  })

  it('strips query params from the filename', () => {
    expect(sanitizeModelPath('checkpoints', 'm.safetensors?token=abc')).toEqual({
      directory: 'checkpoints',
      filename: 'm.safetensors',
    })
  })
})

describe('resolveTemplateModels — URL + path guards', () => {
  beforeEach(() => {
    fetchJSON.mockReset()
  })
  afterEach(() => vi.clearAllMocks())

  async function resolveWith(models: unknown[]): Promise<Awaited<ReturnType<typeof resolveTemplateModels>>> {
    fetchJSON.mockResolvedValue({ models })
    return resolveTemplateModels(inst, 't')
  }

  it('accepts a whitelisted HTTPS model', async () => {
    const out = await resolveWith([model({})])
    expect(out).toEqual([{ filename: 'm.safetensors', url: model({}).url, directory: 'checkpoints' }])
  })

  it('rejects plain http:// (insecure transport)', async () => {
    const out = await resolveWith([model({ url: 'http://huggingface.co/x/m.safetensors' })])
    expect(out).toEqual([])
  })

  it('rejects a non-whitelisted host', async () => {
    const out = await resolveWith([model({ url: 'https://evil.example.com/m.safetensors' })])
    expect(out).toEqual([])
  })

  it('rejects a non-model extension', async () => {
    const out = await resolveWith([model({ url: 'https://huggingface.co/x/m.zip' })])
    expect(out).toEqual([])
  })

  it('drops an entry whose directory traverses out of the models dir', async () => {
    const out = await resolveWith([model({ directory: '../../etc' })])
    expect(out).toEqual([])
  })

  it('drops an entry whose filename carries a path separator', async () => {
    const out = await resolveWith([model({ name: 'sub/m.safetensors' })])
    expect(out).toEqual([])
  })
})
