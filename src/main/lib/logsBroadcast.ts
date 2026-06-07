/**
 * Per-installation log broadcast + buffered backfill.
 *
 * The launching window receives ComfyUI stdout/stderr via direct
 * `sender.send('comfy-output', ...)` calls scattered across the launch /
 * delegate / installation handlers. That's fine for the one window that
 * triggered the launch, but the logs pop-out window needs the SAME stream
 * delivered to a different webContents — and it wants the recent history
 * up front, not just text that arrives after it subscribes.
 *
 * This module owns the broadcast side:
 *
 *   - `appendLog(installationId, text)` is called at every send-site so the
 *     buffer + subscriber broadcast stay in lockstep with the legacy direct
 *     send. The existing send to the launching window is preserved unchanged
 *     — this is a parallel fan-out.
 *
 *   - `subscribeLogs(installationId, wc)` registers a webContents as a live
 *     subscriber and returns the current ring-buffer contents so the
 *     subscriber can paint immediately.
 *
 *   - `unsubscribeLogs(installationId, wc)` removes the subscriber (called
 *     on window close).
 *
 * The buffer is a simple ring of text chunks (not lines). We cap by
 * total character count rather than entries so a burst of tiny chunks
 * can't be evicted by a single big one.
 */

import type { WebContents } from 'electron'

const MAX_BUFFER_CHARS = 256 * 1024 // 256 KB per install — generous, fits any reasonable scrollback

interface InstallLogState {
  buffer: string[]
  bufferSize: number
  subscribers: Set<WebContents>
}

const states = new Map<string, InstallLogState>()

function ensureState(installationId: string): InstallLogState {
  let s = states.get(installationId)
  if (!s) {
    s = { buffer: [], bufferSize: 0, subscribers: new Set() }
    states.set(installationId, s)
  }
  return s
}

function evictUntilBelowCap(state: InstallLogState): void {
  while (state.bufferSize > MAX_BUFFER_CHARS && state.buffer.length > 0) {
    const dropped = state.buffer.shift()!
    state.bufferSize -= dropped.length
  }
}

/**
 * Record a log chunk and broadcast it to every live subscriber.
 * Called at every `sender.send('comfy-output', ...)` site so the
 * pop-out window stays in lockstep with the launching window.
 */
export function appendLog(installationId: string, text: string): void {
  if (!text) return
  const state = ensureState(installationId)
  state.buffer.push(text)
  state.bufferSize += text.length
  evictUntilBelowCap(state)
  for (const wc of state.subscribers) {
    if (wc.isDestroyed()) {
      state.subscribers.delete(wc)
      continue
    }
    try {
      wc.send('logs-output', { installationId, text })
    } catch {
      // Subscriber may have torn down between checks; ignore.
    }
  }
}

export interface LogsRestore {
  installationId: string
  buffer: string[]
}

/**
 * Register a webContents as a subscriber and return the current ring
 * buffer so the new subscriber can paint immediately. Idempotent —
 * re-subscribing the same webContents is a no-op (just returns the
 * fresh buffer).
 */
export function subscribeLogs(installationId: string, wc: WebContents): LogsRestore {
  const state = ensureState(installationId)
  state.subscribers.add(wc)
  // Auto-cleanup if the subscriber webContents goes away without an
  // explicit unsubscribe (window crash, abrupt close).
  wc.once('destroyed', () => {
    state.subscribers.delete(wc)
  })
  return {
    installationId,
    buffer: state.buffer.slice(),
  }
}

export function unsubscribeLogs(installationId: string, wc: WebContents): void {
  const state = states.get(installationId)
  if (!state) return
  state.subscribers.delete(wc)
}

/** Read-only snapshot of the current buffer — used by the popout HTML
 *  for the initial paint when it can't await the subscribe IPC. */
export function getLogsBuffer(installationId: string): string[] {
  const state = states.get(installationId)
  if (!state) return []
  return state.buffer.slice()
}
