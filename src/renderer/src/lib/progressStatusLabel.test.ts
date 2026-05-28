import { describe, it, expect } from 'vitest'
import { humanizeOpStatus } from './progressStatusLabel'

/**
 * `humanizeOpStatus` maps the raw status strings emitted by main during
 * background ops into friendlier UI copy, and falls back to a localized
 * "Working…" when there is no status yet. Both the Update overlay and
 * the snapshots top-card render through this util — the test locks
 * the map so the two surfaces can't drift.
 */

const t = ((key: string, fb?: string) => fb ?? key) as unknown as Parameters<typeof humanizeOpStatus>[1]

describe('humanizeOpStatus', () => {
  it.each([
    ['Loading snapshot…', 'Loading snapshot…'],
    ['Fetching latest stable version', 'Checking for latest version…'],
    ['Fetching version tags…', 'Checking for latest version…'],
    ['Already up to date', 'Already up to date'],
    ['Up to date', 'Already up to date'],
    ['Stopping…', 'Stopping instance…'],
    ['Creating Python environment…', 'Setting up environment…'],
    ['Complete', 'Finishing up…'],
  ])('maps %s → %s', (raw, expected) => {
    expect(humanizeOpStatus(raw, t)).toBe(expected)
  })

  it('passes through unmapped strings verbatim', () => {
    expect(humanizeOpStatus('Custom phase X', t)).toBe('Custom phase X')
  })

  it.each([['', ''], [null, 'null'], [undefined, 'undefined']])(
    'falls back to Working… for empty/null/undefined (%s)',
    (raw) => {
      expect(humanizeOpStatus(raw as string | null | undefined, t)).toBe('Working…')
    }
  )
})
