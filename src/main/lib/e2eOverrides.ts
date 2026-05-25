/**
 * In-memory overrides used only by the E2E suite to bypass production
 * data paths (real GitHub release fetches, real auto-updater, real
 * downloads). Empty in production — the helpers in `e2eHooks.ts` are
 * only registered when `process.env['E2E'] === '1'`.
 *
 * Lives in its own module so production code (e.g. the
 * `computeInstallUpdateAvailable` in `index.ts`) can consult the map
 * with a single `.get()` call without pulling in the rest of the E2E
 * scaffolding.
 */

/** Sentinel key for "apply this override to every installationId". */
export const INSTALL_UPDATE_GLOBAL_KEY = '*'

export interface InstallUpdateOverride {
  available: boolean
  version?: string
}

export const installUpdateOverrides = new Map<string, InstallUpdateOverride>()

export function lookupInstallUpdateOverride(installationId: string): InstallUpdateOverride | undefined {
  return installUpdateOverrides.get(installationId) ?? installUpdateOverrides.get(INSTALL_UPDATE_GLOBAL_KEY)
}

/**
 * IPC invocation counters. Production code increments these via
 * `recordIpcInvocation('channel-name', arg)` when `process.env['E2E']
 * === '1'`; tests read via the `__e2e.getIpcInvocations(channel)`
 * helper. Lets tests assert that a fast-path skipped a costly IPC
 * (e.g. Delete should not call `get-detail-sections`).
 */
const ipcInvocations = new Map<string, unknown[]>()

export function recordIpcInvocation(channel: string, arg?: unknown): void {
  if (process.env['E2E'] !== '1') return
  const arr = ipcInvocations.get(channel)
  if (arr) {
    arr.push(arg)
  } else {
    ipcInvocations.set(channel, [arg])
  }
}

export function getIpcInvocations(channel: string): unknown[] {
  return ipcInvocations.get(channel)?.slice() ?? []
}

export function resetIpcInvocations(channel?: string): void {
  if (channel) ipcInvocations.delete(channel)
  else ipcInvocations.clear()
}

/**
 * URLs passed to Electron's `shell.openExternal(...)` while E2E mode
 * is on. Production code calls `recordShellOpenExternal(url)` from the
 * single launcher-side `openExternal` wrapper. Tests assert this stays
 * empty to prove a download was captured by the session handler
 * instead of bouncing out to the OS browser.
 */
const shellOpenExternalCalls: string[] = []

export function recordShellOpenExternal(url: string): void {
  if (process.env['E2E'] !== '1') return
  shellOpenExternalCalls.push(url)
}

export function getShellOpenExternalCalls(): string[] {
  return shellOpenExternalCalls.slice()
}

export function resetShellOpenExternalCalls(): void {
  shellOpenExternalCalls.length = 0
}
