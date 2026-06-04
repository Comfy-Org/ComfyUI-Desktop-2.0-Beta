import { describe, expect, it, beforeEach } from 'vitest'
import { useDialogs } from './useDialogs'

// `cancel()` must resolve with a kind-specific falsy value (prompt/actionSheet
// → null, alert → undefined, confirm → false), or callers checking one shape
// fall through and fire the action anyway.

describe('useDialogs cancel contract', () => {
  beforeEach(() => {
    // The composable backs a module-level singleton; settle any dangling promise.
    const { cancel } = useDialogs()
    cancel()
  })

  it('resolves a prompt with `null` when cancelled', async () => {
    const { prompt, cancel } = useDialogs()
    const pending = prompt({ title: 'T', message: 'M' })
    cancel()
    await expect(pending).resolves.toBeNull()
  })

  it('resolves an actionSheet with `null` when cancelled', async () => {
    const { actionSheet, cancel } = useDialogs()
    const pending = actionSheet({
      title: 'T',
      items: [{ value: 'a', label: 'A' }]
    })
    cancel()
    await expect(pending).resolves.toBeNull()
  })

  it('resolves an alert with `undefined` when cancelled (ESC/backdrop)', async () => {
    const { alert, cancel } = useDialogs()
    const pending = alert({ title: 'T', message: 'M' })
    cancel()
    await expect(pending).resolves.toBeUndefined()
  })

  it('resolves a confirm with `false` when cancelled', async () => {
    const { confirm, cancel } = useDialogs()
    const pending = confirm({ title: 'T', message: 'M' })
    cancel()
    await expect(pending).resolves.toBe(false)
  })

  it('opening a new dialog while one is in-flight resolves the previous with its kind-appropriate cancel value', async () => {
    const { prompt, confirm } = useDialogs()
    const previous = prompt({ title: 'Prev', message: 'M' })
    // Opening confirm cancels the prompt, which must resolve `null` (its
    // shape), not `false` (confirm's).
    confirm({ title: 'New', message: 'M' })
    await expect(previous).resolves.toBeNull()
  })

  it('confirm primary resolves with `\'primary\'`', async () => {
    const { confirm, confirmPrimary } = useDialogs()
    const pending = confirm({ title: 'T', message: 'M' })
    confirmPrimary()
    await expect(pending).resolves.toBe('primary')
  })

  it('confirm secondary resolves with `\'secondary\'`', async () => {
    const { confirm, confirmSecondary } = useDialogs()
    const pending = confirm({
      title: 'T',
      message: 'M',
      secondaryLabel: 'Close & Launch'
    })
    confirmSecondary()
    await expect(pending).resolves.toBe('secondary')
  })

  it('prompt submit resolves with the submitted value (not null)', async () => {
    const { prompt, submitPrompt } = useDialogs()
    const pending = prompt({ title: 'T', message: 'M' })
    submitPrompt('  edited  ')
    await expect(pending).resolves.toBe('  edited  ')
  })

  it('alert acknowledge resolves `undefined`', async () => {
    const { alert, acknowledgeAlert } = useDialogs()
    const pending = alert({ title: 'T', message: 'M' })
    acknowledgeAlert()
    await expect(pending).resolves.toBeUndefined()
  })
})
