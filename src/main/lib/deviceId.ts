/**
 * Per-installation device identifier.
 *
 * `installation_id` is computed as `SHA-256(machine_id + ':' + salt)`. It is
 * deterministic per machine (same OS-user account, same hardware) and
 * survives a clean reinstall — another Comfy product running on the same
 * machine with the same salt would compute the same hash, which is the
 * mechanism that would let us see one user across products.
 *
 * On first boot post-upgrade for a user whose `device-id.txt` still holds the
 * legacy random UUID, `initDeviceId()` returns that legacy id so the caller
 * can fire a one-shot `posthog.aliasImmediate({ distinctId: new, alias: old })`
 * to merge histories. The boot path is also responsible for marking the
 * migration completed (`markIdentityMigrationCompleted()`) so the alias does
 * not re-fire on subsequent launches.
 *
 * Synchronous `getDeviceId()` is preserved for backward compatibility with
 * the existing IPC handler and main-process call sites. It must only be
 * called after `initDeviceId()` has resolved; if called earlier it falls back
 * to a random UUID flagged as `'random_fallback'` so dashboards can spot it.
 */
import { randomUUID, createHash } from 'crypto'
import path from 'path'
import fs from 'fs'
import si from 'systeminformation'
import { configDir } from './paths'

/**
 * Public namespacing salt for installation_id derivation. Two real jobs:
 *
 *   1. Rotation lever — bumping the version suffix (`-v1` → `-v2`)
 *      invalidates every previously-issued installation_id at once.
 *      Useful as a nuclear option (post-incident, or for a hard reset
 *      of the person graph).
 *   2. Future namespace alignment — if another Comfy product later
 *      ships telemetry and uses this same constant, the two products
 *      will compute the same hash on the same machine, so the analytics
 *      backend can see one person across both.
 *
 * Cryptographically this is friction, not privacy: the salt is in every
 * shipped binary, so an attacker with the binary can extract it. Real
 * privacy comes from consent gating, PII scrubbing, retention limits,
 * and the discipline of never sending `machine_id` off the device — only
 * the hash digest leaves.
 */
const INSTALLATION_ID_SALT = 'comfy-installation-id-v1'

export type IdClass = 'machine_derived' | 'random_fallback'

interface CachedId {
  installationId: string
  idClass: IdClass
}

let cached: CachedId | null = null
let initPromise: Promise<{ legacyId: string | null }> | null = null

function deviceIdPath(): string {
  return path.join(configDir(), 'device-id.txt')
}

function migrationGuardPath(): string {
  return path.join(configDir(), 'identity-migration-completed')
}

/**
 * Persisted legacy-id awaiting a successful alias to the new
 * `installation_id`. Written when we first detect a legacy random UUID
 * during `initDeviceId()`, read on subsequent boots, and cleared by
 * `clearPendingAlias()` once the alias actually ships. Decouples the
 * "we have a legacy id to migrate" signal from the "consent is granted
 * and PostHog is reachable" signal so a user who is on `'undecided'` at
 * first boot still gets their history merged once they consent on a
 * later launch.
 */
function pendingAliasPath(): string {
  return path.join(configDir(), 'pending-identity-alias.txt')
}

const LEGACY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isLegacyUuid(value: string): boolean {
  return LEGACY_UUID_RE.test(value)
}

/**
 * Hard cap on how long we block boot waiting for `systeminformation`'s
 * platform-specific lookups (SMBIOS / WMI / `/sys/class/dmi/id/...`).
 * On VMs and certain firmwares this call can stall for several seconds;
 * past this budget we fall through to `random_fallback` so the splash
 * screen does not freeze on a slow `dmidecode` shell-out.
 */
const MACHINE_ID_TIMEOUT_MS = 2000

async function deriveMachineId(): Promise<{ machineId: string; idClass: IdClass }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const sysPromise = si.system()
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), MACHINE_ID_TIMEOUT_MS)
    })
    const sys = await Promise.race([sysPromise, timeoutPromise])
    if (sys) {
      const uuid = (sys.uuid || '').trim()
      // Reject placeholder-style UUIDs that some firmware reports, plus
      // anything that isn't the full 36-char UUID shape (covers empty
      // strings on restricted Linux reads, OEM sentinels like "Default
      // string" / "To Be Filled By O.E.M.", etc.).
      if (uuid.length === 36 && uuid !== '-' && uuid !== '00000000-0000-0000-0000-000000000000') {
        return { machineId: uuid, idClass: 'machine_derived' }
      }
    }
  } catch {
    // fall through to fallback
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  // Fallback: random UUID, flagged so dashboards can quarantine.
  return { machineId: randomUUID(), idClass: 'random_fallback' }
}

function computeInstallationId(machineId: string): string {
  return createHash('sha256').update(`${machineId}:${INSTALLATION_ID_SALT}`).digest('hex')
}

function isMigrationCompleted(): boolean {
  try {
    return fs.existsSync(migrationGuardPath())
  } catch {
    return false
  }
}

function writeIdFile(installationId: string): void {
  const filePath = deviceIdPath()
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, installationId)
  } catch {
    // best-effort persist; in-memory cache serves the rest of the session
  }
}

function readPendingAlias(): string | null {
  try {
    const raw = fs.readFileSync(pendingAliasPath(), 'utf-8').trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

function writePendingAlias(legacyId: string): void {
  try {
    fs.mkdirSync(path.dirname(pendingAliasPath()), { recursive: true })
    fs.writeFileSync(pendingAliasPath(), legacyId)
  } catch {
    // best-effort persist; if write fails the alias will not retry, which
    // is the same failure mode as a missing PostHog network call.
  }
}

/**
 * Clear the persisted legacy id once the alias has shipped. Idempotent.
 * Called by the boot path's `onAliased` callback so an alias that never
 * shipped (consent denied, network down) gets a fresh attempt next boot.
 */
export function clearPendingAlias(): void {
  try {
    fs.unlinkSync(pendingAliasPath())
  } catch {
    // best effort — already gone is fine.
  }
}

/**
 * Initialize the device identity. Idempotent within a process — repeated
 * calls return the same promise.
 *
 * Returns the legacy id ONLY if a one-shot migration just happened from a
 * pre-v1 random-UUID `device-id.txt`. The caller is expected to fire
 * `posthog.aliasImmediate({ distinctId: installation_id, alias: legacyId })`
 * and a `comfy.desktop.identity.migrated` event, then call
 * `markIdentityMigrationCompleted()` so the alias does not re-fire on
 * subsequent launches.
 *
 * Must be called once at app startup, before any synchronous
 * `getDeviceId()` consumer runs.
 */
export function initDeviceId(): Promise<{ legacyId: string | null }> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    const filePath = deviceIdPath()
    const { machineId, idClass } = await deriveMachineId()
    const newId = computeInstallationId(machineId)

    let existing: string | null = null
    try {
      const raw = fs.readFileSync(filePath, 'utf-8').trim()
      if (raw.length > 0) existing = raw
    } catch {
      // file does not exist yet
    }

    cached = { installationId: newId, idClass }

    // If a previous boot recorded a legacy id but the alias never
    // shipped (consent denied / undecided / network down), retry it
    // this boot. Takes precedence over a fresh detection because by
    // the time we get here the `device-id.txt` was already rewritten
    // on that earlier boot, so `existing` no longer reveals it.
    const persistedLegacy = !isMigrationCompleted() ? readPendingAlias() : null
    if (persistedLegacy) {
      // Keep the on-disk hash in sync with the freshly-computed value
      // (no-op when they already match) but do NOT clear the pending
      // alias — that only happens via `clearPendingAlias()` once the
      // alias actually ships.
      if (existing !== newId) writeIdFile(newId)
      return { legacyId: persistedLegacy }
    }

    if (existing === newId) {
      return { legacyId: null }
    }

    // Existing differs from what we'd compute. Three cases:
    //   (a) existing is a legacy UUID -> first migration, alias it.
    //   (b) existing is a 64-char hex (different hash) -> salt rotated or
    //       cross-machine copy. Update silently, no alias.
    //   (c) existing is garbage -> overwrite, no alias.
    const shouldAlias = existing != null && isLegacyUuid(existing) && !isMigrationCompleted()

    if (shouldAlias && existing) {
      // Persist BEFORE overwriting `device-id.txt` so a process crash
      // between here and a successful alias doesn't lose the legacy id.
      writePendingAlias(existing)
    }

    writeIdFile(newId)
    return { legacyId: shouldAlias ? existing : null }
  })()
  return initPromise
}

/**
 * Synchronous accessor for the bound installation id.
 *
 * Must only be called after `initDeviceId()` has resolved. If called earlier,
 * falls back to a random UUID flagged as `'random_fallback'` so a misordered
 * call never throws and the data is still distinguishable from machine-derived
 * ids in PostHog.
 */
export function getDeviceId(): string {
  if (cached) return cached.installationId

  // Degraded path — getDeviceId() was called before initDeviceId() resolved.
  // Try the on-disk value first; if it's a previously-computed id, use it.
  // Otherwise produce a random UUID (flagged) and persist it best-effort.
  try {
    const raw = fs.readFileSync(deviceIdPath(), 'utf-8').trim()
    if (raw.length > 0) {
      cached = { installationId: raw, idClass: 'random_fallback' }
      return raw
    }
  } catch {
    // fall through
  }
  const id = randomUUID()
  cached = { installationId: id, idClass: 'random_fallback' }
  writeIdFile(id)
  return id
}

export function getIdClass(): IdClass {
  return cached?.idClass ?? 'random_fallback'
}

/**
 * Records that the one-shot legacy-id alias has been issued, so subsequent
 * boots do not re-fire it. Idempotent.
 *
 * Note: if the alias network call ultimately fails to deliver (offline user),
 * we still mark complete so we don't retry on every boot indefinitely. The
 * cost is one legacy-id person not merged in PostHog for that user; PostHog
 * dashboards quarantine `id_class: 'random_fallback'` to mitigate.
 */
export function markIdentityMigrationCompleted(): void {
  try {
    fs.mkdirSync(path.dirname(migrationGuardPath()), { recursive: true })
    fs.writeFileSync(migrationGuardPath(), new Date().toISOString())
  } catch {
    // best effort
  }
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  cached = null
  initPromise = null
}
