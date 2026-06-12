import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useArgsAutocomplete } from './useArgsAutocomplete'
import type { ComfyArgDef } from '../types/ipc'

const SCHEMA: ComfyArgDef[] = [
  { name: 'cpu', flag: '--cpu', help: 'Run on CPU only.', type: 'boolean', category: 'GPU & VRAM' },
  { name: 'lowvram', flag: '--lowvram', help: 'Reduce VRAM.', type: 'boolean', category: 'GPU & VRAM' },
  { name: 'novram', flag: '--novram', help: 'No VRAM.', type: 'boolean', category: 'GPU & VRAM' },
  { name: 'port', flag: '--port', help: 'Server port.', type: 'value', metavar: 'PORT', category: 'Network' },
  {
    name: 'listen',
    flag: '--listen',
    help: 'Listen on host.',
    type: 'optional-value',
    metavar: '[HOST]',
    category: 'Network',
  },
  {
    name: 'cache-ram',
    flag: '--cache-ram',
    help: 'RAM caching thresholds.',
    type: 'multi-value',
    metavar: 'GB',
    category: 'Cache',
  },
  {
    name: 'fp8_e8m0fnu-unet',
    flag: '--fp8_e8m0fnu-unet',
    help: 'Use fp8 e8m0 for the diffusion model.',
    type: 'boolean',
    category: 'Precision',
  },
]

function setup(initial = '', initialFocus = true) {
  const value = ref(initial)
  const schema = ref<ComfyArgDef[]>(SCHEMA)
  const focused = ref(initialFocus)
  const onAccept = vi.fn((next: string) => {
    value.value = next
  })
  const ac = useArgsAutocomplete({ value, schema, focused, onAccept })
  return { value, schema, focused, onAccept, ac }
}

describe('useArgsAutocomplete — searchQuery', () => {
  it('is empty when not focused', () => {
    const { ac, focused } = setup('--lo', false)
    focused.value = false
    expect(ac.searchQuery.value).toBe('')
  })

  it('is empty for empty input', () => {
    const { ac } = setup('')
    expect(ac.searchQuery.value).toBe('')
  })

  it('extracts a flag-name partial with leading dashes', () => {
    const { ac } = setup('--lo')
    expect(ac.searchQuery.value).toBe('lo')
  })

  it('extracts a bare-word partial (no dashes typed yet)', () => {
    const { ac } = setup('lo')
    expect(ac.searchQuery.value).toBe('lo')
  })

  it("returns '--' for bare dashes so the full list opens", () => {
    const { ac } = setup('--')
    expect(ac.searchQuery.value).toBe('--')
  })

  it('returns empty after a trailing space (no partial in flight)', () => {
    const { ac } = setup('--cpu ')
    expect(ac.searchQuery.value).toBe('')
  })

  it('suppresses while filling a required value', () => {
    // After `--port `, the next token is the PORT value — not a flag name.
    const { ac } = setup('--port 81')
    expect(ac.searchQuery.value).toBe('')
  })

  it('does NOT suppress after an optional-value flag', () => {
    // `--listen` is optional-value, so the next token is plausibly
    // either a host OR a new flag — keep the dropdown alive.
    const { ac } = setup('--listen lo')
    expect(ac.searchQuery.value).toBe('lo')
  })

  it('suppresses while filling a multi-value flag (first value)', () => {
    // `--cache-ram 0`: `0` is a threshold value, not the start of a flag, so it
    // must not surface flags whose name contains "0" (e.g. fp8_e8m0fnu-unet).
    const { ac } = setup('--cache-ram 0')
    expect(ac.searchQuery.value).toBe('')
  })

  it('suppresses on later values of a multi-value flag', () => {
    // The flag owns every following value, so the 2nd value is suppressed too.
    const { ac } = setup('--cache-ram 4 8')
    expect(ac.searchQuery.value).toBe('')
  })

  it('does not suggest flag names while typing a multi-value value', () => {
    const { ac } = setup('--cache-ram 0')
    expect(ac.matches.value).toEqual([])
  })

  it('suppresses when the trailing token is an exact known flag with --', () => {
    // User just finished typing `--cpu` — no point suggesting `cpu` itself.
    const { ac } = setup('--cpu')
    expect(ac.searchQuery.value).toBe('')
  })
})

describe('useArgsAutocomplete — matches', () => {
  it('returns flags whose name contains the query', () => {
    const { ac } = setup('--vra')
    const names = ac.matches.value.map((m) => m.name)
    expect(names).toContain('lowvram')
    expect(names).toContain('novram')
    expect(names).not.toContain('cpu')
  })

  it('excludes flags already present in the args string', () => {
    // `--lowvram` is already there; typing another `--vra` shouldn't re-suggest it.
    const { ac } = setup('--lowvram --vra')
    const names = ac.matches.value.map((m) => m.name)
    expect(names).not.toContain('lowvram')
    expect(names).toContain('novram')
  })

  it("returns the full unused list for bare '--'", () => {
    const { ac } = setup('--')
    expect(ac.matches.value.length).toBe(SCHEMA.length)
  })

  it('caps at 8 results', () => {
    const wide = Array.from({ length: 20 }, (_, i) => ({
      name: `flag${i}`,
      flag: `--flag${i}`,
      help: '',
      type: 'boolean' as const,
      category: 'Misc',
    }))
    const { ac, schema } = setup('--flag')
    schema.value = wide
    expect(ac.matches.value.length).toBe(8)
  })

  it('is empty when query is empty', () => {
    const { ac } = setup('')
    expect(ac.matches.value).toEqual([])
  })
})

describe('useArgsAutocomplete — completeArg', () => {
  it('replaces a leading-dashes partial with the full flag + trailing space', () => {
    const { ac, onAccept } = setup('--lo')
    ac.completeArg('lowvram')
    expect(onAccept).toHaveBeenCalledWith('--lowvram ')
  })

  it('replaces a bare-word partial with the dashed flag', () => {
    const { ac, onAccept } = setup('lo')
    ac.completeArg('lowvram')
    expect(onAccept).toHaveBeenCalledWith('--lowvram ')
  })

  it('preserves earlier tokens', () => {
    const { ac, onAccept } = setup('--cpu --lo')
    ac.completeArg('lowvram')
    expect(onAccept).toHaveBeenCalledWith('--cpu --lowvram ')
  })

  it("replaces a bare '--' with the chosen flag", () => {
    const { ac, onAccept } = setup('--cpu --')
    ac.completeArg('lowvram')
    expect(onAccept).toHaveBeenCalledWith('--cpu --lowvram ')
  })
})

describe('useArgsAutocomplete — keymap', () => {
  it('cycles down through matches', () => {
    const { ac } = setup('--vra')
    expect(ac.acIndex.value).toBe(0)
    expect(ac.handleKeydown('ArrowDown')).toBe('consumed')
    expect(ac.acIndex.value).toBe(1)
  })

  it('wraps when arrowing past the ends', () => {
    const { ac } = setup('--vra')
    const n = ac.matches.value.length
    expect(ac.handleKeydown('ArrowUp')).toBe('consumed')
    expect(ac.acIndex.value).toBe(n - 1)
  })

  it('accepts on Enter and on Tab', () => {
    const { ac, onAccept } = setup('--low')
    ac.handleKeydown('Enter')
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onAccept.mock.calls[0]![0]).toMatch(/^--lowvram /)

    onAccept.mockClear()
    const { ac: ac2, onAccept: onAccept2 } = setup('--low')
    ac2.handleKeydown('Tab')
    expect(onAccept2).toHaveBeenCalledTimes(1)
  })

  it('dismisses on Escape and re-opens on next change', async () => {
    const { ac, value } = setup('--vra')
    expect(ac.visible.value).toBe(true)
    ac.handleKeydown('Escape')
    expect(ac.visible.value).toBe(false)
    // Typing another character mutates `value`, which retriggers the
    // matches watch and clears `acDismissed`.
    value.value = '--vram'
    await Promise.resolve()
    await Promise.resolve()
    expect(ac.visible.value).toBe(true)
  })

  it("returns 'pass' for unrelated keys", () => {
    const { ac } = setup('--vra')
    expect(ac.handleKeydown('a')).toBe('pass')
  })

  it("returns 'pass' when there are no visible matches", () => {
    const { ac } = setup('')
    expect(ac.handleKeydown('Enter')).toBe('pass')
  })
})

describe('useArgsAutocomplete — visible', () => {
  it('is false when blurred', () => {
    const { ac, focused } = setup('--vra')
    focused.value = false
    expect(ac.visible.value).toBe(false)
  })

  it('is false with no matches', () => {
    const { ac } = setup('--zzzzzz')
    expect(ac.visible.value).toBe(false)
  })

  it('is true with matches + focus + not dismissed', () => {
    const { ac } = setup('--vra')
    expect(ac.visible.value).toBe(true)
  })
})
