import { beforeEach, describe, expect, it, vi } from 'vitest'

// `./basic` imports `../shared`, which loads electron + the real install
// store at module init. Stub the surface `handleRename` actually touches so
// the unit test runs without a real Electron runtime or datastore.
const hasNameConflict = vi.fn<(id: string, name: string) => Promise<boolean>>()
const update = vi.fn<(id: string, data: Record<string, unknown>) => Promise<unknown>>()

vi.mock('../shared', () => ({
  installations: {
    get hasNameConflict() {
      return hasNameConflict
    },
    get update() {
      return update
    },
  },
  i18n: { t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key) },
  fs: {},
  openPath: vi.fn(),
}))

import { handleRename } from './basic'
import type { ActionContext } from './types'

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    event: {} as ActionContext['event'],
    installationId: 'inst-1',
    inst: { id: 'inst-1', name: 'Old Name' } as ActionContext['inst'],
    actionData: { name: 'New Name' },
    ...overrides,
  }
}

describe('handleRename', () => {
  beforeEach(() => {
    hasNameConflict.mockReset()
    update.mockReset()
    hasNameConflict.mockResolvedValue(false)
    update.mockResolvedValue(undefined)
  })

  it('renames and navigates back to detail on a fresh name', async () => {
    const result = await handleRename(ctx())
    expect(hasNameConflict).toHaveBeenCalledWith('inst-1', 'New Name')
    expect(update).toHaveBeenCalledWith('inst-1', { name: 'New Name' })
    expect(result).toEqual({ ok: true, navigate: 'detail' })
  })

  it('trims surrounding whitespace before persisting', async () => {
    await handleRename(ctx({ actionData: { name: '  Padded  ' } }))
    expect(update).toHaveBeenCalledWith('inst-1', { name: 'Padded' })
  })

  it('rejects an empty / whitespace-only name without writing', async () => {
    const result = await handleRename(ctx({ actionData: { name: '   ' } }))
    expect(update).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toBe('errors.nameRequired')
  })

  it('rejects a duplicate name without writing', async () => {
    hasNameConflict.mockResolvedValue(true)
    const result = await handleRename(ctx())
    expect(update).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('errors.duplicateName')
  })

  it('treats renaming to the current name as a no-op (no write, no conflict check)', async () => {
    const result = await handleRename(ctx({ actionData: { name: 'Old Name' } }))
    expect(hasNameConflict).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, navigate: 'detail' })
  })
})
