import { computed, ref, watch, type Ref } from 'vue'
import type { ComfyArgDef } from '../types/ipc'
import { parseArgs } from '../lib/argsParser'

/**
 * Inline-autocomplete state for the ComfyUI Startup Arguments raw input.
 * Pure logic — no DOM access — so it can be unit-tested without mounting
 * the page. Ports the affordance from the legacy `ArgsBuilder.vue`
 * (`searchQuery`, `autocompleteMatches`, `completeArg`, the keydown
 * keymap) and exposes it as a small reactive API the page wires into a
 * popover next to its text input.
 *
 * Behavior pinned by tests:
 *   - Partial token at the end of `rawValue` (with or without leading
 *     dashes) becomes `searchQuery`.
 *   - Suppressed when the previous token is a `value`-type flag still
 *     awaiting its value — otherwise typing `--port 81` would surface
 *     unrelated flags starting with "81".
 *   - Bare `--` opens the full list of flags not already present.
 *   - `completeArg(name)` replaces the trailing partial with `--name `.
 *   - `acIndex` resets to 0 and `acDismissed` clears whenever matches
 *     change (so Esc only dismisses the *current* set, not future ones).
 */

interface UseArgsAutocompleteOptions {
  /** Current value of the raw args text input — typically `localValue`
   *  in the page. */
  value: Ref<string>
  /** Loaded arg schema. Empty array is fine — produces no matches. */
  schema: Ref<ComfyArgDef[]>
  /** True when the raw input is focused. Caller wires this through
   *  `focus` / `blur` listeners; we gate visibility on it because a
   *  blurred autocomplete reads as a stale ghost panel. */
  focused: Ref<boolean>
  /** Emits the replacement string when the user accepts a suggestion.
   *  Caller writes it back to `localValue` and propagates to the
   *  parent (`update` emit). */
  onAccept: (next: string) => void
}

const MAX_MATCHES = 8

export function useArgsAutocomplete(opts: UseArgsAutocompleteOptions) {
  const { value, schema, focused, onAccept } = opts

  const acIndex = ref(0)
  // Set true on Esc so the popover stays closed until the matches set
  // *changes* (next keystroke). Mirrors the legacy modal.
  const acDismissed = ref(false)

  const parsed = computed(() => parseArgs(value.value, schema.value))

  /**
   * Extracts the partial token the user is currently typing. Returns:
   *   - '' when not focused / empty / unparseable as a partial
   *   - '--' for bare `-` or `--` (caller treats this as "show all")
   *   - the lowercased flag-name fragment otherwise
   */
  const searchQuery = computed<string>(() => {
    if (!focused.value) return ''
    const val = value.value
    if (!val) return ''
    // If the user just typed a space, there's no partial — bail.
    if (val.trimEnd() !== val) return ''
    const allTokens = val.split(/\s+/)
    const lastToken = allTokens.pop() ?? ''
    if (!lastToken) return ''
    // Suppress while filling a required value: previous token is a
    // `--flag` of `value` type (not `boolean`/`optional-value`) without
    // an inline `=value`.
    if (!lastToken.startsWith('-') && allTokens.length > 0) {
      const prev = allTokens[allTokens.length - 1]!
      if (prev.startsWith('--') && !prev.includes('=')) {
        const prevName = prev.slice(2)
        const prevDef = schema.value.find((a) => a.name === prevName)
        if (prevDef && prevDef.type === 'value') return ''
      }
    }
    if (lastToken === '-' || lastToken === '--') return '--'
    const stripped = lastToken.replace(/^-{1,2}/, '')
    const eqIdx = stripped.indexOf('=')
    const name = eqIdx >= 0 ? stripped.slice(0, eqIdx) : stripped
    if (!name) return ''
    // Only suppress for exact matches that already have the -- prefix;
    // bare words like 'port' should still trigger autocomplete so the
    // user gets the dashes added for them.
    if (lastToken.startsWith('-') && schema.value.some((a) => a.name === name)) return ''
    return name.toLowerCase()
  })

  /** Up to 8 schema flags whose name contains the query, excluding any
   *  already present in `value`. With `searchQuery === '--'` (bare
   *  dashes) the substring filter is dropped so the full list shows. */
  const matches = computed<ComfyArgDef[]>(() => {
    const q = searchQuery.value
    if (!q || !schema.value.length) return []
    const filter = q === '--' ? '' : q
    const known = parsed.value.known
    return schema.value
      .filter((a) => (!filter || a.name.includes(filter)) && !known.has(a.name))
      .slice(0, MAX_MATCHES)
  })

  const visible = computed<boolean>(() => matches.value.length > 0 && !acDismissed.value && focused.value)

  // Reset highlight + dismissal on every matches change. Done with a
  // shallow watch on the array identity so it fires on insert/remove
  // but skips no-op recomputes.
  watch(matches, () => {
    acIndex.value = 0
    acDismissed.value = false
  })

  /** Replace the trailing partial in `value` with `--<name> ` and emit. */
  function completeArg(name: string): void {
    const next = value.value.replace(/-{0,2}[\w_-]*$/, `--${name} `)
    onAccept(next)
  }

  /**
   * Keyboard handler — return value indicates whether we consumed the
   * event so the caller can decide whether to call `preventDefault`.
   * The legacy modal called `preventDefault` inside the handler; we
   * keep it pure so the composable stays DOM-free.
   */
  function handleKeydown(key: string): 'consumed' | 'pass' {
    if (!visible.value) return 'pass'
    const total = matches.value.length
    if (key === 'ArrowDown') {
      acIndex.value = (acIndex.value + 1) % total
      return 'consumed'
    }
    if (key === 'ArrowUp') {
      acIndex.value = (acIndex.value - 1 + total) % total
      return 'consumed'
    }
    if (key === 'Tab' || key === 'Enter') {
      const m = matches.value[acIndex.value]
      if (m) completeArg(m.name)
      return 'consumed'
    }
    if (key === 'Escape') {
      acDismissed.value = true
      return 'consumed'
    }
    return 'pass'
  }

  return {
    /** Lowercased partial currently being typed (or '--' for full list). */
    searchQuery,
    /** Schema flags to surface in the popover (≤8). */
    matches,
    /** True when the popover should render. */
    visible,
    /** Highlighted index — mutable so mouse hover can update it. */
    acIndex,
    /** Replace trailing partial with `--<name> ` and notify caller. */
    completeArg,
    /** Run a key code through the keymap. */
    handleKeydown,
  }
}
