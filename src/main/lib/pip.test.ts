import { describe, it, expect } from 'vitest'
import { getPipIndexArgs, PYPI_INDEX_URL, PYPI_MIRROR_URLS, isTorchFamilyPackage, torchConstraintLinesFrom } from './pip'

/** Extract --index-url value from args. */
function getIndexUrl(args: string[]): string | undefined {
  const i = args.indexOf('--index-url')
  return i >= 0 ? args[i + 1] : undefined
}

/** Extract all --extra-index-url values from args. */
function getExtras(args: string[]): string[] {
  const extras: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--extra-index-url') extras.push(args[i + 1]!)
  }
  return extras
}

describe('getPipIndexArgs', () => {
  it('uses pypi.org as --index-url when no mirrors configured', () => {
    const args = getPipIndexArgs()
    expect(getIndexUrl(args)).toBe(PYPI_INDEX_URL)
    expect(getExtras(args)).toEqual([])
  })

  it('does not include Chinese mirrors when useChineseMirrors is false or unset', () => {
    const args = getPipIndexArgs()
    for (const url of PYPI_MIRROR_URLS) {
      expect(args).not.toContain(url)
    }
    expect(getExtras(args)).toHaveLength(0)
  })

  it('uses first Chinese mirror as --index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    expect(getIndexUrl(args)).toBe(PYPI_MIRROR_URLS[0])
  })

  it('demotes pypi.org to --extra-index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    const extras = getExtras(args)
    expect(extras).toContain(PYPI_INDEX_URL)
  })

  it('includes remaining Chinese mirrors as --extra-index-url when useChineseMirrors is true', () => {
    const args = getPipIndexArgs(undefined, true)
    const extras = getExtras(args)
    const expectedExtras = [PYPI_INDEX_URL, ...PYPI_MIRROR_URLS.slice(1)]
    expect(extras).toEqual(expectedExtras)
  })

  it('does not include --index-strategy', () => {
    const noMirror = getPipIndexArgs()
    expect(noMirror).not.toContain('--index-strategy')

    const withMirror = getPipIndexArgs('https://custom.mirror.example/simple/')
    expect(withMirror).not.toContain('--index-strategy')
  })

  it('uses user mirror as --index-url when provided', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror)
    expect(getIndexUrl(args)).toBe(mirror)
  })

  it('demotes pypi.org to --extra-index-url when user mirror is provided', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror)
    const extras = getExtras(args)
    expect(extras).toContain(PYPI_INDEX_URL)
  })

  it('adds user mirror without Chinese mirrors when useChineseMirrors is false', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror, false)
    expect(getIndexUrl(args)).toBe(mirror)
    const extras = getExtras(args)
    expect(extras).toEqual([PYPI_INDEX_URL])
  })

  it('uses user mirror as --index-url with Chinese mirrors and pypi.org as extras', () => {
    const mirror = 'https://custom.mirror.example/simple/'
    const args = getPipIndexArgs(mirror, true)
    expect(getIndexUrl(args)).toBe(mirror)
    const extras = getExtras(args)
    expect(extras).toContain(PYPI_INDEX_URL)
    for (const url of PYPI_MIRROR_URLS) {
      expect(extras).toContain(url)
    }
    expect(extras).toHaveLength(1 + PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror matches pypi.org', () => {
    const args = getPipIndexArgs('https://pypi.org/simple/', true)
    expect(getIndexUrl(args)).toBe('https://pypi.org/simple/')
    const extras = getExtras(args)
    expect(extras).not.toContain('https://pypi.org/simple/')
    expect(extras).toHaveLength(PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror matches pypi.org without trailing slash', () => {
    const args = getPipIndexArgs('https://pypi.org/simple', true)
    const extras = getExtras(args)
    expect(extras).toHaveLength(PYPI_MIRROR_URLS.length)
  })

  it('deduplicates when user mirror is one of the Chinese mirrors', () => {
    const mirror = PYPI_MIRROR_URLS[0]!
    const args = getPipIndexArgs(mirror, true)
    expect(getIndexUrl(args)).toBe(mirror)
    const extras = getExtras(args)
    expect(extras.filter((u) => u === mirror)).toHaveLength(0)
    expect(extras).toHaveLength(1 + PYPI_MIRROR_URLS.length - 1)
  })

  it('treats empty string as no mirror', () => {
    const args = getPipIndexArgs('')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('treats whitespace-only string as no mirror', () => {
    const args = getPipIndexArgs('   ')
    expect(args).toEqual(getPipIndexArgs())
  })

  it('trims whitespace from mirror URL', () => {
    const mirror = '  https://custom.mirror.example/simple/  '
    const args = getPipIndexArgs(mirror)
    expect(getIndexUrl(args)).toBe('https://custom.mirror.example/simple/')
  })

  it('passes undefined the same as no argument', () => {
    expect(getPipIndexArgs(undefined)).toEqual(getPipIndexArgs())
  })
})

describe('isTorchFamilyPackage', () => {
  it('matches the core torch packages', () => {
    for (const name of ['torch', 'torchvision', 'torchaudio', 'torchsde']) {
      expect(isTorchFamilyPackage(name)).toBe(true)
    }
  })

  it('matches other torch-* distributions like torch-tensorrt', () => {
    expect(isTorchFamilyPackage('torch-tensorrt')).toBe(true)
    expect(isTorchFamilyPackage('torch_tensorrt')).toBe(true)
  })

  it('matches nvidia/triton/cuda distributions including dashed and underscored names', () => {
    expect(isTorchFamilyPackage('nvidia-cuda-runtime-cu12')).toBe(true)
    expect(isTorchFamilyPackage('nvidia_cudnn_cu12')).toBe(true)
    expect(isTorchFamilyPackage('triton')).toBe(true)
    expect(isTorchFamilyPackage('cuda-python')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isTorchFamilyPackage('Torch')).toBe(true)
    expect(isTorchFamilyPackage('NVIDIA-CUDA-NVRTC-CU12')).toBe(true)
  })

  it('does not match unrelated packages that merely share a prefix substring', () => {
    expect(isTorchFamilyPackage('torchmetrics-lite')).toBe(false) // not a dash/underscore boundary after "torch"
    expect(isTorchFamilyPackage('cudatoolkit')).toBe(false)
    expect(isTorchFamilyPackage('numpy')).toBe(false)
    expect(isTorchFamilyPackage('spandrel')).toBe(false)
  })
})

describe('torchConstraintLinesFrom', () => {
  it('pins installed torch-family packages to exact versions, preserving local CUDA tags', () => {
    const lines = torchConstraintLinesFrom({
      torch: '2.5.1+cu121',
      torchvision: '0.20.1+cu121',
      'nvidia-cuda-runtime-cu12': '12.1.105',
      numpy: '1.26.4',
      spandrel: '0.4.1',
    })
    expect(lines).toContain('torch==2.5.1+cu121')
    expect(lines).toContain('torchvision==0.20.1+cu121')
    expect(lines).toContain('nvidia-cuda-runtime-cu12==12.1.105')
    expect(lines).not.toContain('numpy==1.26.4')
    expect(lines.some((l) => l.startsWith('spandrel'))).toBe(false)
  })

  it('skips editable and direct URL/VCS references that have no plain version', () => {
    const lines = torchConstraintLinesFrom({
      torch: '-e git+https://github.com/pytorch/pytorch@abc123#egg=torch',
      torchvision: 'git+https://example.com/torchvision.git',
      torchaudio: 'torchaudio @ file:///wheels/torchaudio.whl',
    })
    expect(lines).toEqual([])
  })

  it('returns an empty array when nothing is in the torch family', () => {
    expect(torchConstraintLinesFrom({ numpy: '1.26.4', pillow: '10.0.0' })).toEqual([])
  })
})
