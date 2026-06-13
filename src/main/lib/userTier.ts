/**
 * Cloud user-tier cache. Holds the signed-in customer's subscription tier so the cloud
 * capacity kill-switch sheds new free traffic without denying paying users.
 *
 * Sourced from comfy-api `GET /customers/me` (via the cloud webContents' Firebase token) and
 * persisted to `userData/cloud-user-tier.json` so the next launch's first render sees it.
 * Anomalies leave the cache alone rather than clobber a known-paid tier. Capacity gating treats
 * `unknown === free` (fails closed) — acceptable for launch week.
 */
import { app, type WebContents } from 'electron'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as telemetry from './telemetry'

export type CloudUserTier = 'free' | 'paid' | 'unknown'

/** Subscription tier names that map to `paid`; anything else (FREE, missing, malformed) maps to `free`. */
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

/** Boot-time read of the persisted tier. Idempotent; never rejects (missing/malformed stays `'unknown'`). */
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

/** Update cache + persisted file from a raw `subscription_tier`; null/missing → `free`. No-op when unchanged. */
async function setTier(rawTierName: string | null | undefined): Promise<void> {
  const next: CloudUserTier =
    typeof rawTierName === 'string' && PAID_TIER_NAMES.has(rawTierName.toUpperCase())
      ? 'paid'
      : 'free'
  if (next === cached) return
  const previous = cached
  cached = next
  // Emit only on a real transition between two known tiers. The first
  // resolution out of `unknown` is hydration, not a change, so it is not a
  // conversion signal. A `free → paid` flip shortly after
  // `billing.checkout_returned` is the desktop-visible conversion.
  if (previous === 'free' || previous === 'paid') {
    telemetry.capture('comfy.desktop.billing.tier_changed', {
      from_tier: previous,
      to_tier: next,
    })
  }
  try {
    await fs.writeFile(
      getPersistPath(),
      JSON.stringify({ tier: next, ts: Date.now() }),
      'utf-8',
    )
  } catch (err) {
     
    console.log('[user-tier] persist failed:', err)
  }
}

/**
 * Page-context script that reads the Firebase token from IndexedDB and calls `/customers/me`.
 * Returns `{tier}` on success, `{error}` on recoverable failure, or `null` if no signed-in user.
 * Runs in the cloud page's isolated context so main never handles a raw Firebase token.
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

/** Fire-and-forget tier refresh against a cloud webContents. Errors never throw; leave cache alone. */
export async function refreshCloudUserTier(webContents: WebContents): Promise<void> {
  try {
    const result = (await webContents.executeJavaScript(FETCH_TIER_JS)) as FetchResult | null
    if (!result) {
      // No signed-in record; don't overwrite a known-paid cache (may be transient during sign-in).
      return
    }
    if (result.error) {
       
      console.log('[user-tier] refresh skipped:', result.error)
      return
    }
    await setTier(result.tier ?? null)
     
    console.log('[user-tier] refresh: raw=', result.tier, '→ cached=', cached)
  } catch (err) {
     
    console.log('[user-tier] executeJavaScript failed:', err)
  }
}

/** @internal — exposed for tests. */
export function _resetForTest(): void {
  cached = 'unknown'
  initPromise = null
  persistPath = null
}
