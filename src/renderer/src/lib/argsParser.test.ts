import { describe, expect, it } from 'vitest'
import { validateArgs } from './argsParser'
import type { ComfyArgDef } from '../types/ipc'

const SCHEMA: ComfyArgDef[] = [
  { name: 'cpu', flag: '--cpu', help: 'Run on CPU.', type: 'boolean', category: 'GPU' },
  { name: 'port', flag: '--port', help: 'Port.', type: 'value', metavar: 'PORT', category: 'Net' },
  {
    name: 'preview-method',
    flag: '--preview-method',
    help: 'Preview.',
    type: 'optional-value',
    metavar: 'METHOD',
    category: 'Net',
  },
]

describe('validateArgs', () => {
  it('reports no issues for an empty string', () => {
    const v = validateArgs('', SCHEMA)
    expect(v.tokens).toEqual([])
    expect(v.hasIssues).toBe(false)
  })

  it('marks every token ok for a valid arg string', () => {
    const v = validateArgs('--cpu --port 8188', SCHEMA)
    expect(v.tokens.map((t) => t.status)).toEqual(['ok', 'ok', 'ok'])
    expect(v.hasIssues).toBe(false)
  })

  it('flags an unrecognized flag and swallows its value token', () => {
    const v = validateArgs('--nope value --cpu', SCHEMA)
    expect(v.unsupportedFlags).toEqual(['nope'])
    // The flag and its value are both marked unsupported (value not orphaned).
    expect(v.tokens[0]).toMatchObject({ text: '--nope', status: 'unsupported' })
    expect(v.tokens[1]).toMatchObject({ text: 'value', status: 'unsupported' })
    expect(v.tokens[2]).toMatchObject({ text: '--cpu', status: 'ok' })
    expect(v.orphanedTokens).toEqual([])
    expect(v.hasIssues).toBe(true)
  })

  it('flags a value flag with no value when it is not the last token', () => {
    const v = validateArgs('--port --cpu', SCHEMA)
    expect(v.missingValueFlags).toEqual(['--port'])
    expect(v.hasIssues).toBe(true)
  })

  it('treats a trailing value flag as awaiting (info), not an error', () => {
    const v = validateArgs('--cpu --port', SCHEMA)
    expect(v.missingValueFlags).toEqual([])
    expect(v.awaiting?.text).toBe('--port')
    expect(v.hasIssues).toBe(false)
  })

  it('flags a bare positional token as orphaned', () => {
    const v = validateArgs('foo --cpu', SCHEMA)
    expect(v.orphanedTokens).toEqual(['foo'])
    expect(v.hasIssues).toBe(true)
  })

  it('accepts --flag=value syntax and flags empty =value for value flags', () => {
    expect(validateArgs('--port=8188', SCHEMA).hasIssues).toBe(false)
    const empty = validateArgs('--port=', SCHEMA)
    expect(empty.missingValueFlags).toEqual(['--port='])
    expect(empty.hasIssues).toBe(true)
  })

  it('treats optional-value flags as ok with or without a value', () => {
    expect(validateArgs('--preview-method', SCHEMA).hasIssues).toBe(false)
    expect(validateArgs('--preview-method latent2rgb', SCHEMA).hasIssues).toBe(false)
  })

  describe('suppressTrailingPartial', () => {
    it('does not flag a partial trailing flag while focused (no trailing space)', () => {
      const v = validateArgs('--po', SCHEMA, { suppressTrailingPartial: true })
      expect(v.unsupportedFlags).toEqual([])
      expect(v.hasIssues).toBe(false)
      expect(v.tokens[0]).toMatchObject({ text: '--po', status: 'partial' })
    })

    it('still flags the partial once a trailing space commits the token', () => {
      const v = validateArgs('--po ', SCHEMA, { suppressTrailingPartial: true })
      expect(v.unsupportedFlags).toEqual(['po'])
      expect(v.hasIssues).toBe(true)
    })

    it('flags the partial when not focused (option off)', () => {
      const v = validateArgs('--po', SCHEMA)
      expect(v.unsupportedFlags).toEqual(['po'])
      expect(v.hasIssues).toBe(true)
    })

    it('only suppresses the trailing token, not earlier unknown flags', () => {
      const v = validateArgs('--bogus --po', SCHEMA, { suppressTrailingPartial: true })
      expect(v.unsupportedFlags).toEqual(['bogus'])
      expect(v.hasIssues).toBe(true)
    })

    it('does not suppress a trailing positional value', () => {
      // `81` is a value for --port, already ok — suppression must not touch it.
      const v = validateArgs('--port 81', SCHEMA, { suppressTrailingPartial: true })
      expect(v.tokens.map((t) => t.status)).toEqual(['ok', 'ok'])
      expect(v.hasIssues).toBe(false)
    })
  })
})
