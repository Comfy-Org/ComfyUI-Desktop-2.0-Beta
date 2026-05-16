import type { ComfyArgDef } from '../types/ipc'

/**
 * Pure parser/serializer for ComfyUI launch-argument strings, used by
 * the brand-redesigned `ArgsBuilderPage.vue` (drawer v2). Same algorithm
 * the legacy `ArgsBuilder.vue` runs inline — extracted here so the new
 * component can stay UI-only without duplicating ~80 lines of token /
 * parse / serialize logic.
 *
 * The legacy file keeps its own inline copy; we don't touch it. When
 * the legacy modal is deleted post-migration, that inline copy goes
 * with it; this module remains as the single source.
 */

export interface ParsedArgs {
  /** Schema-known flags, keyed by arg name (no `--` prefix). Value is
   *  the raw string after `=` or the following whitespace-token (empty
   *  for booleans). */
  known: Map<string, string>
  /** Tokens we didn't recognize against the schema — preserved verbatim
   *  so unknown / typo'd flags round-trip without data loss. */
  extra: string[]
}

/** Shell-style tokenizer: splits on whitespace, respects single/double
 *  quotes. Same behavior as the legacy `tokenize` in ArgsBuilder.vue. */
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

/** Parse a raw launch-args string against the given schema. Splits into
 *  `known` (schema-matched flags with their values) + `extra` (unknown
 *  tokens preserved verbatim). */
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

/** Render a parsed args struct back to a shell string. Quotes values
 *  that contain whitespace so the result round-trips through tokenize. */
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
