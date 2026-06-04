// In-memory E2E overrides that bypass production data paths; empty in prod.
// Separate module so production code can consult the map without pulling in
// the rest of the E2E scaffolding.

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

// IPC invocation log (E2E only) so tests can assert a fast-path skipped a
// costly IPC, e.g. Delete should not call `get-detail-sections`.
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

// shell.openExternal URLs (E2E only); tests assert this stays empty to prove a
// download was captured by the session handler instead of the OS browser.
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
