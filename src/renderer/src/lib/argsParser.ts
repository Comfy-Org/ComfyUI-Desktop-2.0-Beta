import type { ComfyArgDef } from '../types/ipc'

// Pure parser/serializer for ComfyUI launch-argument strings.

export interface ParsedArgs {
  /** Schema-known flags keyed by arg name (no `--` prefix); value is empty for booleans. */
  known: Map<string, string>
  /** Unrecognized tokens, preserved verbatim so they round-trip without data loss. */
  extra: string[]
}

/** Shell-style tokenizer: splits on whitespace, respects single/double quotes. */
export function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote: string | null = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
        continue
      }
      current += ch
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** Parse a raw launch-args string against the schema into `known` + `extra`. */
export function parseArgs(raw: string, schema: ComfyArgDef[]): ParsedArgs {
  const tokens = tokenize(raw)
  const schemaMap = new Map(schema.map((a) => [a.name, a]))
  const known = new Map<string, string>()
  const extra: string[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (token.startsWith('--')) {
      const rest = token.slice(2)
      const eqIdx = rest.indexOf('=')
      const name = eqIdx >= 0 ? rest.slice(0, eqIdx) : rest
      const eqValue = eqIdx >= 0 ? rest.slice(eqIdx + 1) : undefined
      const def = schemaMap.get(name)
      if (def) {
        if (def.type === 'boolean') {
          known.set(name, eqValue ?? '')
          i++
        } else if (eqValue !== undefined) {
          known.set(name, eqValue)
          i++
        } else {
          const next = tokens[i + 1]
          if (next !== undefined && !next.startsWith('--')) {
            known.set(name, next)
            i += 2
          } else {
            known.set(name, '')
            i++
          }
        }
      } else {
        // Unknown flag — keep verbatim, including any value token.
        extra.push(token)
        i++
        if (eqValue === undefined && i < tokens.length && !tokens[i]!.startsWith('--')) {
          extra.push(tokens[i]!)
          i++
        }
      }
    } else {
      extra.push(token)
      i++
    }
  }

  return { known, extra }
}

/** Per-token validation status for the raw-args field. */
export type ArgTokenStatus = 'ok' | 'unsupported' | 'missing-value' | 'awaiting-value' | 'orphaned'

export interface ArgToken {
  text: string
  status: ArgTokenStatus
  tooltip?: string
}

export interface ArgValidation {
  /** Every token in order, tagged with its status (drives the colored display). */
  tokens: ArgToken[]
  /** Unrecognized `--flag` names (without the leading dashes). */
  unsupportedFlags: string[]
  /** `--flag` tokens that require a value but have none (not the trailing one). */
  missingValueFlags: string[]
  /** Bare positional tokens not consumed by any flag. */
  orphanedTokens: string[]
  /** Trailing value-flag still waiting for its value — an info hint, not an error. */
  awaiting: ArgToken | null
  /** True when there is at least one real (non-awaiting) problem. */
  hasIssues: boolean
}

/**
 * Classify a raw launch-args string against the schema for inline validation.
 * Pure (no DOM) so it can be unit-tested. A trailing value-flag with no value
 * yet is reported as `awaiting-value` (info) rather than an error, so it doesn't
 * flash red while the user is still typing.
 */
export function validateArgs(raw: string, schema: ComfyArgDef[]): ArgValidation {
  const tokens = tokenize(raw)
  const schemaMap = new Map(schema.map((a) => [a.name, a]))
  const result: ArgToken[] = []

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    const isLast = i === tokens.length - 1
    if (token.startsWith('--')) {
      const rest = token.slice(2)
      const eqIdx = rest.indexOf('=')
      const name = eqIdx >= 0 ? rest.slice(0, eqIdx) : rest
      const eqValue = eqIdx >= 0 ? rest.slice(eqIdx + 1) : undefined
      const def = schemaMap.get(name)
      if (name === '') {
        // A bare `--`; harmless, leave unflagged.
        result.push({ text: token, status: 'ok' })
        i++
      } else if (!def) {
        result.push({
          text: token,
          status: 'unsupported',
          tooltip: 'Unrecognized argument — will not be passed when launching'
        })
        i++
        // Swallow a trailing value so it isn't double-flagged as orphaned.
        if (i < tokens.length && !tokens[i]!.startsWith('--')) {
          result.push({ text: tokens[i]!, status: 'unsupported' })
          i++
        }
      } else if (eqValue !== undefined) {
        if (eqValue === '' && def.type === 'value') {
          result.push({
            text: token,
            status: 'missing-value',
            tooltip: `Requires a value: ${def.metavar || 'VALUE'}`
          })
        } else {
          result.push({ text: token, status: 'ok' })
        }
        i++
      } else if (def.type === 'value') {
        const next = tokens[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          result.push({ text: token, status: 'ok' })
          result.push({ text: next, status: 'ok' })
          i += 2
        } else if (isLast) {
          result.push({
            text: token,
            status: 'awaiting-value',
            tooltip: `Next: provide ${def.metavar || 'VALUE'}`
          })
          i++
        } else {
          result.push({
            text: token,
            status: 'missing-value',
            tooltip: `Requires a value: ${def.metavar || 'VALUE'}`
          })
          i++
        }
      } else {
        // Boolean or optional-value flag.
        result.push({ text: token, status: 'ok' })
        i++
        if (def.type === 'optional-value' && i < tokens.length && !tokens[i]!.startsWith('--')) {
          result.push({ text: tokens[i]!, status: 'ok' })
          i++
        }
      }
    } else {
      result.push({
        text: token,
        status: 'orphaned',
        tooltip: 'Unexpected positional argument — use --flag syntax'
      })
      i++
    }
  }

  const unsupportedFlags = result
    .filter((t) => t.status === 'unsupported' && t.text.startsWith('--'))
    .map((t) => t.text.slice(2).split('=')[0]!)
  const missingValueFlags = result.filter((t) => t.status === 'missing-value').map((t) => t.text)
  const orphanedTokens = result.filter((t) => t.status === 'orphaned').map((t) => t.text)
  const awaiting = result.find((t) => t.status === 'awaiting-value') ?? null

  return {
    tokens: result,
    unsupportedFlags,
    missingValueFlags,
    orphanedTokens,
    awaiting,
    hasIssues:
      unsupportedFlags.length > 0 || missingValueFlags.length > 0 || orphanedTokens.length > 0
  }
}

/** Render parsed args back to a shell string, quoting values with whitespace so they round-trip. */
export function serialize(known: Map<string, string>, extra: string[]): string {
  const parts: string[] = []
  for (const [name, value] of known) {
    parts.push(`--${name}`)
    if (value !== '') {
      parts.push(value.includes(' ') ? `"${value}"` : value)
    }
  }
  parts.push(...extra.map((e) => (e.includes(' ') ? `"${e}"` : e)))
  return parts.join(' ')
}
