import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../main', () => ({
  i18n: { global: { t: (k: string) => k } },
}))

import { useDialogs } from '../composables/useDialogs'
import { useModal } from '../composables/useModal'
import { dismissPickerModals } from './dismissPickerModals'

describe('dismissPickerModals', () => {
  const modal = useModal()
  const dialogs = useDialogs()

  beforeEach(() => {
    modal.close(null)
  })

  it('cancels an open useModal.confirm as false (matches backdrop click)', async () => {
    const promise = modal.confirm({ title: 'Update ComfyUI', message: 'Are you sure?' })
    dismissPickerModals()
    await expect(promise).resolves.toBe(false)
    expect(modal.state.visible).toBe(false)
  })

  it('cancels an open useModal.prompt as null', async () => {
    const promise = modal.prompt({ title: 'Name', message: 'Pick a name' })
    dismissPickerModals()
    await expect(promise).resolves.toBeNull()
  })

  it('cancels an open useDialogs.confirm as false', async () => {
    const promise = dialogs.confirm({ title: 'Confirm', message: 'OK?' })
    dismissPickerModals()
    await expect(promise).resolves.toBe(false)
    expect(dialogs.state.open).toBe(false)
  })

  it('cancels an open useDialogs.prompt as null', async () => {
    const promise = dialogs.prompt({ title: 'Name' })
    dismissPickerModals()
    await expect(promise).resolves.toBeNull()
  })

  it('cancels BOTH layers when both happen to be open at once', async () => {
    const modalP = modal.confirm({ title: 'A', message: 'a' })
    const dialogsP = dialogs.confirm({ title: 'B', message: 'b' })
    dismissPickerModals()
    await expect(modalP).resolves.toBe(false)
    await expect(dialogsP).resolves.toBe(false)
  })

  it('is a no-op when no modal is open', () => {
    expect(() => dismissPickerModals()).not.toThrow()
    expect(modal.state.visible).toBe(false)
    expect(dialogs.state.open).toBe(false)
  })
})
