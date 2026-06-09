import { describe, it, expect, vi, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'home') return os.homedir()
      return path.join(os.tmpdir(), 'comfyui-desktop-2-test')
    },
  },
  BrowserWindow: class {},
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

beforeAll(async () => {
  const mod = await import('./comfyDownloadManager')
  ALLOWED_EXTENSIONS = mod.ALLOWED_EXTENSIONS
  hasValidExtension = mod.hasValidExtension
  isPathContained = mod.isPathContained
  sanitizeAssetFilename = mod.sanitizeAssetFilename
  parseContentDispositionFilename = mod.parseContentDispositionFilename
  buildSaveDialogFilters = mod.buildSaveDialogFilters
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
