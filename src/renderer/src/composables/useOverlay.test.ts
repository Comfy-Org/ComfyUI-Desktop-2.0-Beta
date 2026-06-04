import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useOverlay } from './useOverlay'

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
  // Identity translator — tests assert against the i18n keys themselves.
  i18n: { global: { t: (key: string) => key } },
}))

describe('useOverlay — cancel-prompt copy', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    // Reset the singleton overlay slot so test order doesn't matter.
    useOverlay().current.value = null
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

    // Install-flow takeovers keep the generic copy until they opt in.
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

  it("uses the dedicated 'Discard install setup?' copy when an install-flow takeover sets cancelCopyKey: 'discard-setup'", async () => {
    confirmMock.mockResolvedValueOnce(true)
    const { openOverlay, closeOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'new-install',
      cancelCopyKey: 'discard-setup',
    })

    await closeOverlay()
    expect(confirmMock).toHaveBeenCalledWith({
      title: 'overlay.discardSetupTitle',
      message: 'overlay.discardSetupMessage',
      confirmLabel: 'overlay.discardSetupConfirm',
      confirmStyle: 'danger',
    })
    expect(current.value).toBeNull()
  })
})

describe('useOverlay — onCancel firing', () => {
  beforeEach(() => {
    confirmMock.mockReset()
    // Reset the singleton overlay slot so test order doesn't matter.
    useOverlay().current.value = null
  })

  it('fires onCancel after the user confirms the cancel-prompt for an in-flight progress overlay', async () => {
    // onCancel must fire before the slot clears so the main-side op rolls back.
    confirmMock.mockResolvedValueOnce(true)
    const onCancel = vi.fn()
    const { openOverlay, closeOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'progress',
      installationId: 'inst-1',
      operationName: 'Installing',
      onCancel,
    })

    const cleared = await closeOverlay()
    expect(cleared).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(current.value).toBeNull()
  })

  it('fires onCancel after confirm when an in-flight progress overlay is pre-empted by a Tier 3 takeover (no orphaned op)', async () => {
    // Without onCancel here the original op would be orphaned when the
    // takeover replaces it.
    confirmMock.mockResolvedValueOnce(true)
    const onCancel = vi.fn()
    const { openOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'progress',
      installationId: 'inst-1',
      operationName: 'Installing',
      onCancel,
    })
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      installationId: 'inst-2',
      operationName: 'Updating ComfyUI',
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(current.value?.kind).toBe('takeover')
  })

  it('does NOT fire onCancel when the user dismisses the cancel-prompt', async () => {
    // The slot stays mounted — the underlying op must keep running, so
    // onCancel must NOT have fired.
    confirmMock.mockResolvedValueOnce(false)
    const onCancel = vi.fn()
    const { openOverlay, closeOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      installationId: 'inst-1',
      operationName: 'Updating ComfyUI',
      onCancel,
    })

    const cleared = await closeOverlay()
    expect(cleared).toBe(false)
    expect(onCancel).not.toHaveBeenCalled()
    expect(current.value?.kind).toBe('takeover')
  })

  it('does NOT fire onCancel on a Tier 3 → Tier 3 swap when both overlays target the same installationId (re-present, not abandon)', async () => {
    // Same install = re-present; firing onCancel would cancel the very op
    // the new overlay is about to show.
    const onCancel = vi.fn()
    const { openOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      installationId: 'inst-1',
      operationName: 'Updating ComfyUI',
      onCancel,
    })
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      installationId: 'inst-1',
      operationName: 'Updating ComfyUI',
    })
    expect(onCancel).not.toHaveBeenCalled()
    expect(current.value?.kind).toBe('takeover')
  })

  it('fires onCancel on a Tier 3 → Tier 3 swap when the install differs (chain-local / cross-install handoff)', async () => {
    // Different installationId means the prior takeover is being
    // abandoned, not re-presented — its onCancel must fire so the
    // underlying op (if any) is told to roll back.
    const onCancel = vi.fn()
    const { openOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      installationId: 'inst-1',
      operationName: 'Updating ComfyUI',
      onCancel,
    })
    await openOverlay({
      kind: 'takeover',
      component: 'update',
      installationId: 'inst-2',
      operationName: 'Updating ComfyUI',
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(current.value?.kind).toBe('takeover')
  })

  it('does not require onCancel — closing without it still clears the slot on confirm', async () => {
    // Wizard takeovers (install flows / first-use) carry no
    // onCancel; the cancel-prompt for those just dismisses the
    // wizard with no main-side rollback to fire.
    confirmMock.mockResolvedValueOnce(true)
    const { openOverlay, closeOverlay, current } = useOverlay()
    await openOverlay({
      kind: 'takeover',
      component: 'new-install',
      cancelCopyKey: 'discard-setup',
    })

    const cleared = await closeOverlay()
    expect(cleared).toBe(true)
    expect(current.value).toBeNull()
  })
})
