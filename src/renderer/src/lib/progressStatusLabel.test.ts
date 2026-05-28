import { describe, it, expect } from 'vitest'
import {
  humanizeOpStatus,
  operationInflightLabel,
  operationSuccessLabel,
} from './progressStatusLabel'

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

/**
 * Per-action title helpers — the picker's progress overlay used to
 * hardcode "Updating…" / "Update complete" for every actionId. These
 * tests lock the mapping so future actions get an explicit label or
 * fall back through the documented chain (op.title → "Working…").
 */
describe('operationInflightLabel', () => {
  it.each([
    [{ actionId: 'update-comfyui',        actionData: {} },                       'Updating…'],
    [{ actionId: 'update-comfyui',        actionData: { isDowngrade: true } },    'Downgrading…'],
    [{ actionId: 'release-update' },                                              'Updating…'],
    [{ actionId: 'copy' },                                                        'Copying…'],
    [{ actionId: 'copy-update' },                                                 'Copying & updating…'],
    [{ actionId: 'delete' },                                                      'Deleting…'],
    [{ actionId: 'snapshot-restore' },                                            'Restoring snapshot…'],
    [{ actionId: 'snapshot-save' },                                               'Saving snapshot…'],
    [{ actionId: 'snapshot-delete' },                                             'Deleting snapshot…'],
    [{ actionId: 'migrate-to-standalone' },                                       'Migrating…'],
  ])('actionId=%j → %s', (op, expected) => {
    expect(operationInflightLabel(op, t)).toBe(expected)
  })

  it('falls back to op.title for unknown actionIds', () => {
    expect(operationInflightLabel({ actionId: 'mystery', title: 'Doing the thing…' }, t)).toBe('Doing the thing…')
  })

  it('falls back to Working… when op.title is also empty', () => {
    expect(operationInflightLabel({ actionId: 'mystery' }, t)).toBe('Working…')
  })
})

describe('operationSuccessLabel', () => {
  it.each([
    [{ actionId: 'update-comfyui',        actionData: {} },                       'Update complete'],
    [{ actionId: 'update-comfyui',        actionData: { isDowngrade: true } },    'Downgrade complete'],
    [{ actionId: 'release-update' },                                              'Update complete'],
    [{ actionId: 'copy' },                                                        'Copy complete'],
    [{ actionId: 'copy-update' },                                                 'Copy complete'],
    [{ actionId: 'delete' },                                                      'Deleted'],
    [{ actionId: 'snapshot-restore' },                                            'Snapshot restored'],
    [{ actionId: 'snapshot-save' },                                               'Snapshot saved'],
    [{ actionId: 'snapshot-delete' },                                             'Snapshot deleted'],
    [{ actionId: 'migrate-to-standalone' },                                       'Migration complete'],
  ])('actionId=%j → %s', (op, expected) => {
    expect(operationSuccessLabel(op, t)).toBe(expected)
  })

  it('falls back to Done for unknown actionIds', () => {
    expect(operationSuccessLabel({ actionId: 'mystery' }, t)).toBe('Done')
  })
})
