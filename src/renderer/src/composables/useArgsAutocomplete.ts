import { computed, ref, watch, type Ref } from 'vue'
import type { ComfyArgDef } from '../types/ipc'
import { parseArgs } from '../lib/argsParser'

/** Inline-autocomplete state for the ComfyUI Startup Arguments raw input.
 *  Pure logic — no DOM access — so it can be unit-tested. */

interface UseArgsAutocompleteOptions {
  value: Ref<string>
  schema: Ref<ComfyArgDef[]>
  /** True when the raw input is focused; gates visibility so a blurred
   *  autocomplete doesn't linger as a stale ghost panel. */
  focused: Ref<boolean>
  onAccept: (next: string) => void
}

const MAX_MATCHES = 8

export function useArgsAutocomplete(opts: UseArgsAutocompleteOptions) {
  const { value, schema, focused, onAccept } = opts

  const acIndex = ref(0)
  // Set true on Esc so the popover stays closed until the matches change.
  const acDismissed = ref(false)

  const parsed = computed(() => parseArgs(value.value, schema.value))

  /** Partial token being typed: '' when none, '--' for bare dashes
   *  (caller shows all), else the lowercased flag-name fragment. */
  const searchQuery = computed<string>(() => {
    if (!focused.value) return ''
    const val = value.value
    if (!val) return ''
    if (val.trimEnd() !== val) return ''
    const allTokens = val.split(/\s+/)
    const lastToken = allTokens.pop() ?? ''
    if (!lastToken) return ''
    // Suppress while filling a `value`-type flag's required value, so
    // `--port 81` doesn't surface flags starting with "81".
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
    // Only suppress exact matches that already have the `--` prefix; bare
    // words like 'port' still autocomplete so the dashes get added.
    if (lastToken.startsWith('-') && schema.value.some((a) => a.name === name)) return ''
    return name.toLowerCase()
  })

  /** Up to 8 flags whose name contains the query, excluding those already
   *  in `value`. `'--'` drops the substring filter to show the full list. */
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

  // Reset highlight + dismissal on every matches change.
  watch(matches, () => {
    acIndex.value = 0
    acDismissed.value = false
  })

  /** Replace the trailing partial in `value` with `--<name> ` and emit. */
  function completeArg(name: string): void {
    const next = value.value.replace(/-{0,2}[\w_-]*$/, `--${name} `)
    onAccept(next)
  }

  /** Return value tells the caller whether to `preventDefault` (kept
   *  pure so the composable stays DOM-free). */
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
    searchQuery,
    matches,
    visible,
    acIndex,
    completeArg,
    handleKeydown,
  }
}
