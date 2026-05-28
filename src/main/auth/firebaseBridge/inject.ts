/**
 * Build the JavaScript string passed to `comfyContents.executeJavaScript`
 * to write the captured Firebase user into the embedded view's IndexedDB
 * and reload the page so Firebase's SDK rehydrates from persistence.
 *
 * Schema (stable across Firebase JS SDK v9-v11):
 *   - DB:     `firebaseLocalStorageDb`
 *   - Store:  `firebaseLocalStorage`
 *   - KeyPath:`fbase_key`
 *   - Key:    `firebase:authUser:<apiKey>:[DEFAULT]`
 *   - Value:  `{ fbase_key, value: <user.toJSON()> }`
 *
 * After the write, `location.reload()` triggers Firebase's persistence
 * read on init, which fires `onAuthStateChanged(user)` and lets the
 * cloud frontend's existing `useSessionCookie.createSession()` flow
 * post the ID token to `/auth/session` — same path as a normal popup
 * sign-in.
 */
export function buildIndexedDbInjectScript(user: Record<string, unknown>, apiKey: string): string {
  const userJson = JSON.stringify(user)
  const apiKeyJson = JSON.stringify(apiKey)
  // Wrapped in an IIFE that resolves once the IDB transaction commits
  // (so `executeJavaScript`'s returned Promise tracks the actual write).
  return `(async () => {
  const userValue = ${userJson};
  const apiKey = ${apiKeyJson};
  const storageKey = 'firebase:authUser:' + apiKey + ':[DEFAULT]';
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('firebaseLocalStorageDb', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('firebaseLocalStorage')) {
        db.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
      }
    };
    req.onerror = () => reject(new Error('open: ' + (req.error && req.error.message || 'unknown')));
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('firebaseLocalStorage', 'readwrite');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(new Error('tx: ' + (tx.error && tx.error.message || 'unknown')));
      const store = tx.objectStore('firebaseLocalStorage');
      store.put({ fbase_key: storageKey, value: userValue });
    };
  });
  // Tell the next page-load (handled by attach.ts's dom-ready patch) to
  // hide documentElement briefly so the cloud login page doesn't flash
  // between Firebase rehydrating and the FE redirecting to the workspace.
  try { sessionStorage.setItem('__comfyDesktopPostSignin', '1'); } catch (_) {}
  location.reload();
})()`
}
