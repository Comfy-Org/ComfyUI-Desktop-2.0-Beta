import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

const mockConfirm = vi.fn()
vi.mock('./useModal', () => ({
  useModal: () => ({
    confirm: mockConfirm,
  }),
}))

import { useQuitDesktopConfirm } from './useQuitDesktopConfirm'

describe('useQuitDesktopConfirm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prompts the Quit Desktop confirm with danger styling (matches other confirm modals)', async () => {
    mockConfirm.mockResolvedValue(true)
    const { confirmQuitDesktop } = useQuitDesktopConfirm()

    const result = await confirmQuitDesktop()

    expect(mockConfirm).toHaveBeenCalledWith({
      title: 'dashboard.confirmQuit.title',
      message: 'dashboard.confirmQuit.message',
      confirmLabel: 'dashboard.confirmQuit.confirmLabel',
      confirmStyle: 'danger',
    })
    expect(result).toBe(true)
  })

  it('returns false when the user cancels', async () => {
    mockConfirm.mockResolvedValue(false)
    const { confirmQuitDesktop } = useQuitDesktopConfirm()

    expect(await confirmQuitDesktop()).toBe(false)
  })
})
