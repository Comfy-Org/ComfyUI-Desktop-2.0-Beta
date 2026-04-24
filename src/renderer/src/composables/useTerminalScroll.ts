import { type Ref, ref, watch, nextTick } from 'vue'

/**
 * Shared terminal scroll behavior: auto-scroll to bottom, expand/collapse toggle.
 *
 * @param terminalRef - Template ref for the terminal scroll container.
 * @param getOutput - A getter that returns the current terminal output string.
 */
export function useTerminalScroll(
  terminalRef: Ref<HTMLDivElement | null>,
  getOutput: () => string | undefined,
) {
  const isAtBottom = ref(true)
  const terminalExpanded = ref(true)

  function handleTerminalScroll(): void {
    if (!terminalRef.value) return
    const el = terminalRef.value
    isAtBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  function scrollToBottom(): void {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight
    }
  }

  watch(getOutput, async () => {
    if (!isAtBottom.value) return
    await nextTick()
    scrollToBottom()
  })

  watch(terminalExpanded, async (expanded) => {
    if (!expanded) return
    await nextTick()
    if (isAtBottom.value) scrollToBottom()
  })

  return {
    isAtBottom,
    terminalExpanded,
    handleTerminalScroll,
    scrollToBottom,
  }
}
