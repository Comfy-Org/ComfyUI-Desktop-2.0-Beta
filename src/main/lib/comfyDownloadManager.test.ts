import { describe, it, expect, vi, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'
import type { buildExistenceCandidates as BuildExistenceCandidates } from './comfyDownloadManager'
import type * as ComfyDownloadManager from './comfyDownloadManager'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return os.homedir()
      return path.join(os.tmpdir(), 'comfyui-desktop-2-test')
    },
  },
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  dialog: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  shell: {},
}))

let ALLOWED_EXTENSIONS: string[]
let hasValidExtension: (filename: string) => boolean
let isPathContained: (filePath: string, baseDir: string) => boolean
let sanitizeAssetFilename: (filename: string, outputDir: string) => string | null
let parseContentDispositionFilename: (header: string | null) => string | null
let buildSaveDialogFilters: (suggestedName: string) => Electron.FileFilter[]
let buildExistenceCandidates: typeof BuildExistenceCandidates
let mod: typeof ComfyDownloadManager

beforeAll(async () => {
  mod = await import('./comfyDownloadManager')
  ALLOWED_EXTENSIONS = mod.ALLOWED_EXTENSIONS
  hasValidExtension = mod.hasValidExtension
  isPathContained = mod.isPathContained
  sanitizeAssetFilename = mod.sanitizeAssetFilename
  parseContentDispositionFilename = mod.parseContentDispositionFilename
  buildSaveDialogFilters = mod.buildSaveDialogFilters
  buildExistenceCandidates = mod.buildExistenceCandidates
})

describe('buildExistenceCandidates', () => {
  it('uses only the destination when there is no install context', () => {
    const candidates = buildExistenceCandidates(null, '/shared', 'loras', 'x.safetensors')
    expect(candidates).toEqual([path.join('/shared', 'loras', 'x.safetensors')])
  })

  it('probes every model root for the folder type', () => {
    const ctx = {
      downloadBaseDir: '/install/models',
      modelRoots: ['/install/models', '/external'],
      extraPaths: [],
    }
    const candidates = buildExistenceCandidates(ctx, '/install/models', 'loras', 'x.safetensors')
    expect(candidates).toContain(path.join('/install/models', 'loras', 'x.safetensors'))
    expect(candidates).toContain(path.join('/external', 'loras', 'x.safetensors'))
    // The global shared dir is NOT a root here, so it must not be probed.
    expect(candidates).not.toContain(path.join('/shared', 'loras', 'x.safetensors'))
  })

  it('probes arbitrarily-mapped extra_model_paths dirs for the type', () => {
    const ctx = {
      downloadBaseDir: '/install/models',
      modelRoots: ['/install/models'],
      extraPaths: [
        { section: 's', basePath: null, type: 'loras', rawType: 'loras', dir: '/custom/somedir/myname', isDefault: false },
        { section: 's', basePath: null, type: 'checkpoints', rawType: 'checkpoints', dir: '/custom/cp', isDefault: false },
      ],
    }
    const candidates = buildExistenceCandidates(ctx, '/install/models', 'loras', 'x.safetensors')
    expect(candidates).toContain(path.join('/custom/somedir/myname', 'x.safetensors'))
    // checkpoints mapping must not be probed for a loras download.
    expect(candidates).not.toContain(path.join('/custom/cp', 'x.safetensors'))
  })

  it('probes a model root for both controlnet/ and its t2i_adapter/ alternate', () => {
    const ctx = {
      downloadBaseDir: '/install/models',
      modelRoots: ['/install/models'],
      extraPaths: [],
    }
    const candidates = buildExistenceCandidates(ctx, '/install/models', 'controlnet', 'x.safetensors')
    // ComfyUI's controlnet defaults also search <root>/t2i_adapter, and the
    // launcher YAML registers it under controlnet, so both must be probed.
    expect(candidates).toContain(path.join('/install/models', 'controlnet', 'x.safetensors'))
    expect(candidates).toContain(path.join('/install/models', 't2i_adapter', 'x.safetensors'))
  })

  it('matches legacy folder aliases (clip → text_encoders)', () => {
    const ctx = {
      downloadBaseDir: '/install/models',
      modelRoots: ['/install/models'],
      extraPaths: [
        { section: 's', basePath: null, type: 'text_encoders', rawType: 'clip', dir: '/custom/clip', isDefault: false },
      ],
    }
    const candidates = buildExistenceCandidates(ctx, '/install/models', 'clip', 'x.safetensors')
    expect(candidates).toContain(path.join('/custom/clip', 'x.safetensors'))
  })

  it('appends a nested directory remainder when probing extra dirs', () => {
    const ctx = {
      downloadBaseDir: '/install/models',
      modelRoots: ['/install/models'],
      extraPaths: [
        { section: 's', basePath: null, type: 'loras', rawType: 'loras', dir: '/custom/loras', isDefault: false },
      ],
    }
    const candidates = buildExistenceCandidates(ctx, '/install/models', 'loras/sub', 'x.safetensors')
    expect(candidates).toContain(path.join('/custom/loras', 'sub', 'x.safetensors'))
  })
})

describe('ALLOWED_EXTENSIONS', () => {
  const requiredExtensions = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt']

  it.each(requiredExtensions)('includes %s', (ext) => {
    expect(ALLOWED_EXTENSIONS).toContain(ext)
  })
})

describe('hasValidExtension', () => {
  it.each([
    'model.safetensors',
    'model.sft',
    'model.ckpt',
    'model.pth',
    'model.pt',
  ])('returns true for %s', (filename) => {
    expect(hasValidExtension(filename)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(hasValidExtension('model.SafeTensors')).toBe(true)
  })

  it('returns false for disallowed extensions', () => {
    expect(hasValidExtension('script.py')).toBe(false)
    expect(hasValidExtension('archive.zip')).toBe(false)
  })
})

describe('isPathContained', () => {
  it('returns true when file is inside base directory', () => {
    expect(isPathContained('/models/stable-diffusion/model.sft', '/models')).toBe(true)
  })

  it('returns false when file is outside base directory', () => {
    expect(isPathContained('/other/model.sft', '/models')).toBe(false)
  })
})

describe('sanitizeAssetFilename', () => {
  const outputDir = process.platform === 'win32' ? 'C:\\output' : '/output'

  it('returns simple filenames unchanged', () => {
    expect(sanitizeAssetFilename('image.png', outputDir)).toBe('image.png')
  })

  it('allows subfolder paths', () => {
    expect(sanitizeAssetFilename('myimages/output.png', outputDir)).toBe('myimages/output.png')
  })

  it('strips path traversal components', () => {
    expect(sanitizeAssetFilename('../../etc/passwd', outputDir)).toBe('etc/passwd')
    expect(sanitizeAssetFilename('../secret.txt', outputDir)).toBe('secret.txt')
    expect(sanitizeAssetFilename('a/../../b/file.png', outputDir)).toBe('a/b/file.png')
  })

  it('strips dot segments', () => {
    expect(sanitizeAssetFilename('./file.png', outputDir)).toBe('file.png')
    expect(sanitizeAssetFilename('a/./b/file.png', outputDir)).toBe('a/b/file.png')
  })

  it('normalises backslashes', () => {
    expect(sanitizeAssetFilename('sub\\dir\\file.png', outputDir)).toBe('sub/dir/file.png')
    expect(sanitizeAssetFilename('..\\..\\etc\\passwd', outputDir)).toBe('etc/passwd')
  })

  it('strips leading slashes', () => {
    expect(sanitizeAssetFilename('/absolute/path.png', outputDir)).toBe('absolute/path.png')
    expect(sanitizeAssetFilename('///triple.png', outputDir)).toBe('triple.png')
  })

  it('returns null for empty or whitespace filenames', () => {
    expect(sanitizeAssetFilename('', outputDir)).toBeNull()
    expect(sanitizeAssetFilename('   ', outputDir)).toBeNull()
  })

  it('returns null for filenames that resolve to nothing after sanitisation', () => {
    expect(sanitizeAssetFilename('..', outputDir)).toBeNull()
    expect(sanitizeAssetFilename('../..', outputDir)).toBeNull()
    expect(sanitizeAssetFilename('.', outputDir)).toBeNull()
  })
})

describe('parseContentDispositionFilename', () => {
  it('returns null for null/empty input', () => {
    expect(parseContentDispositionFilename(null)).toBeNull()
    expect(parseContentDispositionFilename('')).toBeNull()
  })

  it('parses quoted filename', () => {
    expect(parseContentDispositionFilename('attachment; filename="photo.png"')).toBe('photo.png')
  })

  it('parses unquoted filename', () => {
    expect(parseContentDispositionFilename('attachment; filename=photo.png')).toBe('photo.png')
  })

  it('parses RFC 5987 encoded filename*', () => {
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''NetaYume_%E7%A7%98.png")).toBe('NetaYume_秘.png')
  })

  it('prefers filename* over filename', () => {
    expect(parseContentDispositionFilename("attachment; filename=\"fallback.png\"; filename*=UTF-8''preferred.png")).toBe('preferred.png')
  })

  it('parses GCS response-content-disposition format', () => {
    expect(parseContentDispositionFilename('attachment; filename="NetaYume_Lumina_3.5_00187_.png"')).toBe('NetaYume_Lumina_3.5_00187_.png')
  })

  it('returns null for header without filename', () => {
    expect(parseContentDispositionFilename('inline')).toBeNull()
    expect(parseContentDispositionFilename('attachment')).toBeNull()
  })
})

/**
 * The Preview Image "Save image..." right-click goes through Electron's
 * generic Save dialog; Windows collapses the "Save as type" dropdown to
 * "All Files (*.*)" if `filters` is omitted, which is the symptom field-
 * reported in #989. These tests lock the primary-extension inference and
 * the All Files fallback so the dialog always opens on a sensible format.
 */
describe('buildSaveDialogFilters (#989 save-image extension filters)', () => {
  it('picks PNG as the primary filter for a .png filename', () => {
    const filters = buildSaveDialogFilters('ComfyUI_00001_.png')
    expect(filters[0]).toEqual({ name: 'PNG Image', extensions: ['png'] })
    expect(filters.at(-1)).toEqual({ name: 'All Files', extensions: ['*'] })
  })

  it('groups jpg and jpeg under the same JPEG family filter', () => {
    expect(buildSaveDialogFilters('photo.jpg')[0]).toEqual({
      name: 'JPEG Image',
      extensions: ['jpg', 'jpeg'],
    })
    expect(buildSaveDialogFilters('photo.jpeg')[0]).toEqual({
      name: 'JPEG Image',
      extensions: ['jpg', 'jpeg'],
    })
  })

  it.each([
    ['out.webp', 'WebP Image', 'webp'],
    ['anim.gif', 'GIF Image', 'gif'],
    ['clip.mp4', 'MP4 Video', 'mp4'],
    ['clip.webm', 'WebM Video', 'webm'],
    ['clip.mov', 'QuickTime Video', 'mov'],
    ['voice.wav', 'WAV Audio', 'wav'],
    ['voice.mp3', 'MP3 Audio', 'mp3'],
    ['voice.flac', 'FLAC Audio', 'flac'],
    ['voice.ogg', 'OGG Audio', 'ogg'],
  ] as const)('maps %s to %s', (filename, expectedName, expectedExt) => {
    const filters = buildSaveDialogFilters(filename)
    expect(filters[0]).toEqual({ name: expectedName, extensions: [expectedExt] })
    expect(filters.at(-1)).toEqual({ name: 'All Files', extensions: ['*'] })
  })

  it('is case-insensitive on the input extension', () => {
    expect(buildSaveDialogFilters('CAPS.PNG')[0]).toEqual({
      name: 'PNG Image',
      extensions: ['png'],
    })
  })

  it('falls back to a literal-extension filter for unknown types', () => {
    const filters = buildSaveDialogFilters('weird.xyz')
    expect(filters[0]).toEqual({ name: 'XYZ File', extensions: ['xyz'] })
    expect(filters.at(-1)).toEqual({ name: 'All Files', extensions: ['*'] })
  })

  it('returns only All Files when there is no extension at all', () => {
    expect(buildSaveDialogFilters('justname')).toEqual([
      { name: 'All Files', extensions: ['*'] },
    ])
  })
})

describe('template tray-mirror cleanup', () => {
  const entry = (url: string, status: 'downloading' | 'completed') => ({
    url,
    filename: url.split('/').pop()!,
    progress: status === 'completed' ? 100 : 40,
    status,
  })

  it('dismissRecentDownload removes a finished mirrored template row', () => {
    mod.setTemplateTrayMirror('inst-a', [entry('template-model://checkpoints/m.safetensors', 'completed')])
    expect(mod.getDownloadsTrayState().recent.some((r) => r.url.includes('m.safetensors'))).toBe(true)

    expect(mod.dismissRecentDownload('template-model://checkpoints/m.safetensors')).toBe(true)
    expect(mod.getDownloadsTrayState().recent.some((r) => r.url.includes('m.safetensors'))).toBe(false)
  })

  it('clearFinishedDownloads purges terminal mirror rows but keeps in-flight ones', () => {
    mod.setTemplateTrayMirror('inst-b', [
      entry('template-model://vae/done.safetensors', 'completed'),
      entry('template-model://vae/live.safetensors', 'downloading'),
    ])
    const removed = mod.clearFinishedDownloads()
    expect(removed).toBeGreaterThanOrEqual(1)

    const tray = mod.getDownloadsTrayState()
    expect(tray.recent.some((r) => r.url.includes('done.safetensors'))).toBe(false)
    // The still-downloading row survives in `active`.
    expect(tray.active.some((r) => r.url.includes('live.safetensors'))).toBe(true)

    mod.clearTemplateTrayMirror('inst-b') // cleanup so other tests start clean
  })
})

describe('template mirror visibility in the All-Downloads modal', () => {
  const entry = (url: string) => ({
    url,
    filename: url.split('/').pop()!,
    progress: 40,
    status: 'downloading' as const,
  })

  it('getAllDownloads() includes template-mirror rows (modal seed)', () => {
    mod.setTemplateTrayMirror('inst-seed', [entry('template-model://loras/x.safetensors')])
    expect(mod.getAllDownloads().some((d) => d.url.includes('x.safetensors'))).toBe(true)
    mod.clearTemplateTrayMirror('inst-seed')
  })

  it('setTemplateTrayMirror fans each row out as model-download-progress (modal live)', async () => {
    const { BrowserWindow } = (await import('electron')) as unknown as {
      BrowserWindow: { getAllWindows: () => unknown[] }
    }
    const send = vi.fn()
    const fakeWin = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    const spy = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([fakeWin])
    try {
      mod.setTemplateTrayMirror('inst-live', [entry('template-model://vae/y.safetensors')])
      const progressCalls = send.mock.calls.filter((c) => c[0] === 'model-download-progress')
      expect(progressCalls.length).toBeGreaterThanOrEqual(1)
      expect(progressCalls.some((c) => (c[1] as { url: string }).url.includes('y.safetensors'))).toBe(true)
    } finally {
      spy.mockRestore()
      mod.clearTemplateTrayMirror('inst-live')
    }
  })
})
