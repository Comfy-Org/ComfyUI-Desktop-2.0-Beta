import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useOverlay } from './useOverlay'

// Inline mocks — useOverlay pulls in vue-i18n via `../i18n` and
// `useModal` from a sibling composable. Both have heavy module-load
// side effects we don't need here; the only behaviour under test is
// the cancel-prompt copy dispatch (Track M-2.4) and the silent-swap
// rules already covered by the PanelApp integration tests.
const confirmMock = vi.fn<(opts: {
  title: string
  message: string
  confirmLabel?: string
  confirmStyle?: string
}) => Promise<boolean>>()

vi.mock('./useModal', () => ({
  useModal: () => ({
    alert: vi.fn(),
    confirm: confirmMock,
    close: vi.fn(),
  }),
}))

vi.mock('../i18n', () => ({
  // Identity translator — the tests assert against the i18n keys
  // themselves so we don't have to keep the locale file in sync with
  // the test's expected copy.
  i18n: { global: { t: (key: string) => key } },
}))

describe('useOverlay — cancel-prompt copy (Track M-2.4)', () => {
  beforeEach(() => {
    confirmMock.mockReset()
  })

  it("uses the dedicated 'Quit setup?' copy when a takeover sets cancelCopyKey: 'quit-setup'", async () => {
    confirmMock.mockResolvedValueOnce(true)
    const { openOverlay, closeOverlay, current } = useOverlay()

    await openOverlay({
      kind: 'takeover',
      component: 'first-use',
      cancelCopyKey: 'quit-setup',
    })
    expect(current.value?.kind).toBe('takeover')

    const cleared = await closeOverlay()
    expect(cleared).toBe(true)
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock).toHaveBeenCalledWith({
      title: 'overlay.quitSetupTitle',
      message: 'overlay.quitSetupMessage',
      confirmLabel: 'overlay.quitSetupConfirm',
      confirmStyle: 'danger',
    })
    expect(current.value).toBeNull()
  })

  it('falls back to the generic cancel copy when no cancelCopyKey is set', async () => {
    confirmMock.mockResolvedValueOnce(true)
    const { openOverlay, closeOverlay, current } = useOverlay()

    // Install-flow takeovers (M-3 migration target) keep the generic
    // copy until they opt in.
    await openOverlay({ kind: 'takeover', component: 'new-install' })

    await closeOverlay()
    expect(confirmMock).toHaveBeenCalledWith({
      title: 'overlay.cancelCurrentTitle',
      message: 'overlay.cancelMessage',
      confirmLabel: 'overlay.cancelConfirm',
      confirmStyle: 'danger',
    })
    expect(current.value).toBeNull()
  })

  it("uses the named-operation generic title when a takeover carries operationName but no cancelCopyKey", async () => {
    confirmMock.mockResolvedValueOnce(true)
    const { openOverlay, closeOverlay } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      operationName: 'Updating ComfyUI',
    })

    await closeOverlay()
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'overlay.cancelNamedTitle',
        message: 'overlay.cancelMessage',
      }),
    )
  })

  it('aborts the close (returns false) and leaves the overlay mounted when the user dismisses the prompt', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const { openOverlay, closeOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'first-use',
      cancelCopyKey: 'quit-setup',
    })

    const cleared = await closeOverlay()
    expect(cleared).toBe(false)
    expect(current.value?.kind).toBe('takeover')
  })
})
