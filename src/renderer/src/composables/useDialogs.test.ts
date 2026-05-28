import { describe, expect, it, beforeEach } from 'vitest'
import { useDialogs } from './useDialogs'

/**
 * Regression coverage for the cancel-value contract. The `cancel()`
 * helper resolves the in-flight promise with a falsy value sized to
 * the dialog kind:
 *
 *   - prompt / actionSheet → `null`
 *   - alert → `undefined`
 *   - confirm → `false`
 *
 * A regression here surfaces as "click Cancel → action fires anyway"
 * because callers that check `=== null` fall through when the cancel
 * value is `false` (or vice versa). The Save Snapshot flow hit this
 * exact bug on a real user click — the prompt's cancel resolved
 * `false`, `if (label === null)` was falsy, and `runAction` fired.
 */

describe('useDialogs cancel contract', () => {
  beforeEach(() => {
    // The composable backs onto a module-level singleton; the
    // cancel call in each `it` settles whatever in-flight promise
    // the previous test left dangling, but the helper makes a
    // fresh open() resolve cleanly regardless.
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
    // Opening confirm should cancel the in-flight prompt — and that
    // prompt should resolve `null` (its cancel shape), not `false`
    // (confirm's). Without the per-kind helper this is the exact
    // path that produced the Save Snapshot regression.
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
