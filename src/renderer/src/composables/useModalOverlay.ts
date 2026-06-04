import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Shared modal overlay behavior: escape-to-close, click-outside-to-close.
 *
 * @param shouldClose - Returns true when the modal is open and should respond to escape/overlay clicks.
 * @param close - Called when the modal should close.
 */
export function useModalOverlay(
  shouldClose: () => boolean,
  close: () => void,
) {
  const mouseDownOnOverlay = ref(false)

  function handleOverlayMouseDown(event: MouseEvent): void {
    mouseDownOnOverlay.value = event.target === (event.currentTarget as HTMLElement)
  }

  function handleOverlayClick(event: MouseEvent): void {
    if (mouseDownOnOverlay.value && event.target === (event.currentTarget as HTMLElement)) {
      close()
    }
    mouseDownOnOverlay.value = false
  }

  function handleEscapeKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && shouldClose()) {
      event.stopImmediatePropagation()
      close()
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handleEscapeKey)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', handleEscapeKey)
  })

  return {
    mouseDownOnOverlay,
    handleOverlayMouseDown,
    handleOverlayClick,
  }
}
