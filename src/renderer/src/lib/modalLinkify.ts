/**
 * Shared markdown-lite formatter for modal copy: escapes HTML, turns
 * `https://…` runs into clickable anchors that route through
 * `window.api.openExternal`, and renders `**bold**` as `<strong>`.
 * Used by `ModalDialog`, `BasePrompt`, and `BaseSelect` so prompt /
 * select / confirm bodies share identical link + emphasis behavior.
 */

function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

export function linkify(text: string): string {
  if (!text) return ''
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g)
  return parts
    .map((part, i) => {
      const escaped = escapeHtml(part)
      if (i % 2 === 1) {
        return `<a href="#" class="modal-link" data-url="${escaped}">${escaped}</a>`
      }
      return escaped
    })
    .join('')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

export function handleModalLinkClick(event: MouseEvent): void {
  const target = event.target as HTMLElement
  if (target.classList.contains('modal-link')) {
    event.preventDefault()
    const url = target.dataset.url
    if (url) {
      window.api.openExternal(url)
    }
  }
}
