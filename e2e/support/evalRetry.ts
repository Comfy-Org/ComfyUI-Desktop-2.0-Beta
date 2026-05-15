/**
 * Retry wrapper for Playwright Electron `app.evaluate(...)` calls.
 *
 * Playwright's electron evaluation channel intermittently throws
 * "Execution context was destroyed, most likely because of a
 * navigation" on heavily-loaded CI runners (especially Windows). The
 * underlying CDP channel can be torn down briefly when the host
 * window's child WebContentsViews (popup pre-warm, tray open/close,
 * system-modal pre-warm) are created or destroyed in quick succession
 * — Playwright's evaluation target gets invalidated, and the very
 * next call fails before the channel is re-established.
 *
 * The error is recoverable: a retry on the next event-loop tick lands
 * on a fresh evaluation context. Wrap evaluate-style calls in this
 * helper instead of letting transient channel resets fail the whole
 * test.
 */

const RETRY_PATTERN = /Execution context was destroyed/i

export async function evalWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (!RETRY_PATTERN.test(msg)) throw err
      // Backoff just long enough for Playwright to re-attach to a
      // fresh evaluation context — 50ms is well past the typical
      // re-attach window we've measured in CI.
      await new Promise((r) => setTimeout(r, 50 * (i + 1)))
    }
  }
  throw lastErr
}
