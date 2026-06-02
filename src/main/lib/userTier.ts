/**
 * Cloud user-tier cache.
 *
 * Holds the signed-in Comfy customer's subscription tier so the cloud
 * capacity-protection switch can let paying users through `disabled`:
 * a launch-week kill-switch should shed *new* free traffic, not deny
 * the product to people who already pay for it.
 *
 * Sourcing
 * --------
 * The user's tier lives in comfy-api's `customers.subscription_tier`
 * (FREE / STANDARD / CREATOR / PRO / FOUNDERS_EDITION). We fetch it
 * via `GET /customers/me`, authenticated with the Firebase ID token
 * that the embedded cloud webContents already holds in IndexedDB.
 *
 * `refreshCloudUserTier(comfyContents)` is invoked from `attach.ts`'s
 * `dom-ready` handler for cloud installs (alongside the existing
 * `COMFY_CLOUD_PATCHES_JS` injection). It executes a small script in
 * the cloud page's context that reads the cached Firebase auth record
 * and posts `/customers/me`. Anything anomalous (no record, expired
 * token, network failure, non-OK response) is treated as "leave cache
 * alone" rather than clobber a known-paid tier.
 *
 * Persistence
 * -----------
 * Tier is also written to `userData/cloud-user-tier.json` so the very
 * first dashboard render on the NEXT launch sees the right value
 * without having to open a cloud install first. The on-disk format is
 * intentionally trivial — a single `{tier, ts}` record — so a future
 * rewrite that adds e.g. an expiry can land without a migration.
 *
 * Failure mode
 * ------------
 * "Unknown" is a real state: the user is signed out, hasn't opened
 * cloud this session, or there's no persisted record yet. Capacity
 * gating treats `unknown === free` (see useCloudCapacity), which
 * fails *closed* — protecting capacity at the cost of occasionally
 * blocking a paying user who hasn't opened cloud yet this lifetime
 * of the app. Acceptable for launch week.
 */
import { app, type WebContents } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'

export type CloudUserTier = 'free' | 'paid' | 'unknown'

/** Subscription tier names that map to `paid`. Anything else (incl.
 *  `FREE`, missing, malformed) maps to `free`. */
const PAID_TIER_NAMES: ReadonlySet<string> = new Set([
  'STANDARD',
  'CREATOR',
  'PRO',
  'FOUNDERS_EDITION',
])

const PERSIST_FILENAME = 'cloud-user-tier.json'

let cached: CloudUserTier = 'unknown'
let initPromise: Promise<void> | null = null
let persistPath: string | null = null

function getPersistPath(): string {
  if (!persistPath) {
    persistPath = path.join(app.getPath('userData'), PERSIST_FILENAME)
  }
  return persistPath
}

/**
 * Boot-time read of the persisted tier. Idempotent across calls. Never
 * rejects — a missing or malformed file just leaves the cache at
 * `'unknown'` and is treated as `'free'` downstream.
 */
export function initUserTier(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const raw = await fs.readFile(getPersistPath(), 'utf-8')
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'tier' in parsed &&
        (parsed.tier === 'free' || parsed.tier === 'paid')
      ) {
        cached = parsed.tier
      }
    } catch {
      // first launch, missing file, or corrupt — stay 'unknown'
    }
    // eslint-disable-next-line no-console
    console.log('[user-tier] init: persisted=', cached)
  })()
  return initPromise
}

export function getUserTier(): CloudUserTier {
  return cached
}

export async function getUserTierAsync(): Promise<CloudUserTier> {
  if (initPromise) {
    try {
      await initPromise
    } catch {
      /* keep cached */
    }
  }
  return cached
}

/**
 * Update the cache + persisted file from a raw `subscription_tier`
 * string returned by comfy-api. `null` / `undefined` / missing string
 * is treated as `free` (the user signed in, no subscription record).
 *
 * No-op when the resolved tier matches the current cache — avoids
 * unnecessary disk writes on every cloud reload.
 */
async function setTier(rawTierName: string | null | undefined): Promise<void> {
  const next: CloudUserTier =
    typeof rawTierName === 'string' && PAID_TIER_NAMES.has(rawTierName.toUpperCase())
      ? 'paid'
      : 'free'
  if (next === cached) return
  cached = next
  try {
    await fs.writeFile(
      getPersistPath(),
      JSON.stringify({ tier: next, ts: Date.now() }),
      'utf-8',
    )
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[user-tier] persist failed:', err)
  }
}

/**
 * Page-context script that reads the cached Firebase auth record from
 * IndexedDB, extracts the current ID token, and calls comfy-api's
 * `/customers/me`. Returns one of:
 *   - `{tier: 'FREE' | 'STANDARD' | ...}` on success
 *   - `{error: '<code>'}` on a recoverable failure
 *   - `null` if no signed-in user record is present
 *
 * Runs entirely in the cloud webContents' isolated page context so
 * main never has to handle a raw Firebase token.
 */
const FETCH_TIER_JS = `(async () => {
  try {
    const dbReq = indexedDB.open('firebaseLocalStorageDb');
    const db = await new Promise((res, rej) => {
      dbReq.onsuccess = () => res(dbReq.result);
      dbReq.onerror = () => rej(dbReq.error);
    });
    const tx = db.transaction('firebaseLocalStorage', 'readonly');
    const store = tx.objectStore('firebaseLocalStorage');
    const allReq = store.getAll();
    const all = await new Promise((res, rej) => {
      allReq.onsuccess = () => res(allReq.result);
      allReq.onerror = () => rej(allReq.error);
    });
    const userEntry = (all || []).find(e =>
      e && typeof e === 'object' &&
      typeof e.fbase_key === 'string' &&
      e.fbase_key.indexOf('firebase:authUser:') === 0
    );
    if (!userEntry || !userEntry.value || !userEntry.value.stsTokenManager) return null;
    const token = userEntry.value.stsTokenManager.accessToken;
    if (typeof token !== 'string' || token.length === 0) return null;
    const resp = await fetch('https://api.comfy.org/customers/me', {
      headers: { 'Authorization': 'Bearer ' + token },
      credentials: 'omit',
    });
    if (!resp.ok) return { error: 'http_' + resp.status };
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== 'object') return { error: 'bad_json' };
    return { tier: data.subscription_tier || 'FREE' };
  } catch (e) {
    return { error: (e && e.message) ? String(e.message) : 'unknown' };
  }
})()`

interface FetchResult {
  tier?: string
  error?: string
}

/**
 * Fire-and-forget tier refresh against a cloud webContents. Called
 * from `attach.ts`'s `dom-ready` handler for cloud installs. Errors
 * never throw — at worst we log and leave the existing cache alone.
 */
export async function refreshCloudUserTier(webContents: WebContents): Promise<void> {
  try {
    const result = (await webContents.executeJavaScript(FETCH_TIER_JS)) as FetchResult | null
    if (!result) {
      // No signed-in record. Don't overwrite a known-paid cache —
      // could be a transient state during sign-in.
      return
    }
    if (result.error) {
      // eslint-disable-next-line no-console
      console.log('[user-tier] refresh skipped:', result.error)
      return
    }
    await setTier(result.tier ?? null)
    // eslint-disable-next-line no-console
    console.log('[user-tier] refresh: raw=', result.tier, '→ cached=', cached)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log('[user-tier] executeJavaScript failed:', err)
  }
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  cached = 'unknown'
  initPromise = null
  persistPath = null
}
