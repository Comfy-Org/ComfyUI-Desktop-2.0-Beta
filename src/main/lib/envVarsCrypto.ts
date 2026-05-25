import { safeStorage } from 'electron'

/**
 * On-disk envelope for an encrypted env var value. We tag with a version
 * so future format changes don't get misread as plaintext.
 */
interface EncryptedValue {
  __enc: 'v1'
  data: string
}

export type StoredEnvVars = Record<string, string | EncryptedValue>

function isEnvelope(v: unknown): v is EncryptedValue {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    (v as { __enc?: unknown }).__enc === 'v1' &&
    typeof (v as { data?: unknown }).data === 'string'
  )
}

/**
 * Whether Electron's safeStorage is wired up to a real OS keychain. On Linux
 * without a keyring this returns false and we fall back to plaintext rather
 * than block the user from saving env vars at all.
 */
export function envVarEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/**
 * Encrypt plaintext env-var values for at-rest storage in installations.json.
 * Returns a structurally identical record with each value wrapped in an
 * { __enc, data } envelope. Falls back to plaintext when safeStorage isn't
 * available so users on keyring-less Linux still get a working app.
 */
export function encryptEnvVars(plain: Record<string, string>): StoredEnvVars {
  if (!envVarEncryptionAvailable()) return { ...plain }
  const out: StoredEnvVars = {}
  for (const [k, v] of Object.entries(plain)) {
    try {
      const buf = safeStorage.encryptString(v)
      out[k] = { __enc: 'v1', data: buf.toString('base64') }
    } catch {
      out[k] = v
    }
  }
  return out
}

/**
 * Decrypt stored env vars back to a plain key→value map. Accepts mixed
 * input (envelope + legacy plain-string values) so records written before
 * encryption shipped still load. Unrecoverable entries are dropped rather
 * than surfaced as ciphertext to the user or the child process.
 */
export function decryptEnvVars(stored: unknown): Record<string, string> {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v
      continue
    }
    if (isEnvelope(v)) {
      try {
        out[k] = safeStorage.decryptString(Buffer.from(v.data, 'base64'))
      } catch {
        // Drop unreadable entries — usually means the keychain entry was
        // wiped or the OS user changed.
      }
    }
  }
  return out
}
