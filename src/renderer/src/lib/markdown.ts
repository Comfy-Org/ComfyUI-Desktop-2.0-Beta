/**
 * Minimal markdown → structured-block parser for legal documents.
 *
 * The source markdown is bundled at build time from `docs/legal/*.md`, so
 * this is operating on first-party content only — no user input ever
 * reaches it. The parser supports the subset of markdown the legal docs
 * actually use: ATX headings (h1-h4), paragraphs with inline bold /
 * italic / code / links, `-`/`*` bullets, `1.` ordered lists, `---`
 * horizontal rules, `> …` blockquotes, fenced ```` ``` ```` code blocks,
 * and pipe tables.
 *
 * Anything fancier (footnotes, definition lists, nested lists deeper than
 * a continuation indent) is intentionally out of scope — the legal docs
 * don't use it. If they ever do, extend this parser instead of pulling in
 * a markdown library; we want zero new runtime deps for one feature.
 */

export type InlineSeg =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string }

export type Block =
  | { kind: 'h1' | 'h2' | 'h3' | 'h4'; text: string }
  | { kind: 'p'; segs: InlineSeg[] }
  | { kind: 'ul' | 'ol'; items: InlineSeg[][] }
  | { kind: 'hr' }
  | { kind: 'blockquote'; segs: InlineSeg[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; headers: InlineSeg[][]; rows: InlineSeg[][][] }

/** Inline parse: walks the string left-to-right and tokenises bold,
 *  italic, code spans, and links. Plain text fills the gaps. Order
 *  matters in the regex alternation — bold (`**…**`) is matched before
 *  italic (`*…*`) to avoid the italic regex eating the inner `*`. */
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

export function parseInline(text: string): InlineSeg[] {
  const segs: InlineSeg[] = []
  let lastIdx = 0
  INLINE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) {
      segs.push({ kind: 'text', text: text.slice(lastIdx, m.index) })
    }
    const tok = m[0]
    if (tok.startsWith('**')) {
      segs.push({ kind: 'bold', text: tok.slice(2, -2) })
    } else if (tok.startsWith('`')) {
      segs.push({ kind: 'code', text: tok.slice(1, -1) })
    } else if (tok.startsWith('[')) {
      const linkMatch = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)
      if (linkMatch && linkMatch[1] !== undefined && linkMatch[2] !== undefined) {
        segs.push({ kind: 'link', text: linkMatch[1], url: linkMatch[2] })
      }
    } else if (tok.startsWith('*')) {
      segs.push({ kind: 'italic', text: tok.slice(1, -1) })
    }
    lastIdx = INLINE_RE.lastIndex
  }
  if (lastIdx < text.length) {
    segs.push({ kind: 'text', text: text.slice(lastIdx) })
  }
  return segs
}

function isBlockStart(line: string): boolean {
  const t = line.trimStart()
  return (
    t.startsWith('# ') ||
    t.startsWith('## ') ||
    t.startsWith('### ') ||
    t.startsWith('#### ') ||
    t.startsWith('- ') ||
    t.startsWith('* ') ||
    t.startsWith('> ') ||
    t.startsWith('```') ||
    t.startsWith('|') ||
    /^\d+\. /.test(t) ||
    t === '---'
  )
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  // Helper: safely read line at index, returns undefined when out of range.
  const at = (idx: number): string | undefined => lines[idx]

  while (i < lines.length) {
    const line = at(i) ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('#### ')) {
      blocks.push({ kind: 'h4', text: line.slice(5).trim() })
      i++
      continue
    }
    if (line.startsWith('### ')) {
      blocks.push({ kind: 'h3', text: line.slice(4).trim() })
      i++
      continue
    }
    if (line.startsWith('## ')) {
      blocks.push({ kind: 'h2', text: line.slice(3).trim() })
      i++
      continue
    }
    if (line.startsWith('# ')) {
      blocks.push({ kind: 'h1', text: line.slice(2).trim() })
      i++
      continue
    }
    if (line.trim() === '---') {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }
    if (line.startsWith('```')) {
      let j = i + 1
      const codeLines: string[] = []
      let next = at(j)
      while (next !== undefined && !next.startsWith('```')) {
        codeLines.push(next)
        j++
        next = at(j)
      }
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      // Skip the closing fence if present.
      i = next === undefined ? j : j + 1
      continue
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: InlineSeg[][] = []
      let next = line
      while (next.startsWith('- ') || next.startsWith('* ')) {
        items.push(parseInline(next.slice(2)))
        i++
        const peek = at(i)
        if (peek === undefined) break
        next = peek
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    if (/^\d+\. /.test(line)) {
      const items: InlineSeg[][] = []
      let next = line
      while (/^\d+\. /.test(next)) {
        items.push(parseInline(next.replace(/^\d+\. /, '')))
        i++
        const peek = at(i)
        if (peek === undefined) break
        next = peek
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    if (line.startsWith('> ')) {
      const segs = parseInline(line.slice(2))
      let j = i + 1
      let next = at(j)
      while (next !== undefined && next.startsWith('> ')) {
        segs.push({ kind: 'text', text: ' ' })
        for (const s of parseInline(next.slice(2))) segs.push(s)
        j++
        next = at(j)
      }
      blocks.push({ kind: 'blockquote', segs })
      i = j
      continue
    }
    if (line.startsWith('|')) {
      const tableLines: string[] = []
      let next: string | undefined = line
      while (next !== undefined && next.startsWith('|')) {
        tableLines.push(next)
        i++
        next = at(i)
      }
      const headerLine = tableLines[0]
      if (tableLines.length >= 2 && headerLine !== undefined) {
        const splitRow = (l: string): string[] => {
          // Strip leading + trailing pipes, then split. Empty cells preserved.
          const trimmed = l.replace(/^\|/, '').replace(/\|$/, '')
          return trimmed.split('|').map((s) => s.trim())
        }
        const headers = splitRow(headerLine).map(parseInline)
        // Row 1 is the separator (---|---|---). Skip it.
        const rows = tableLines.slice(2).map((l) => splitRow(l).map(parseInline))
        blocks.push({ kind: 'table', headers, rows })
      }
      continue
    }
    // Paragraph: accumulate until blank line or another block start.
    const paraLines: string[] = [line]
    let j = i + 1
    while (j < lines.length) {
      const next = at(j)
      if (next === undefined || next.trim() === '' || isBlockStart(next)) break
      paraLines.push(next)
      j++
    }
    blocks.push({ kind: 'p', segs: parseInline(paraLines.join(' ')) })
    i = j
  }
  return blocks
}
