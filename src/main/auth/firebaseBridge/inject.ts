/**
 * Build the JS string that writes the captured Firebase user into the embedded
 * view's IndexedDB and reloads so Firebase's SDK rehydrates from persistence
 * and fires `onAuthStateChanged` (same path as a normal popup sign-in).
 *
 * Schema (stable across Firebase JS SDK v9-v11):
 *   - DB `firebaseLocalStorageDb`, store `firebaseLocalStorage`, keyPath
 *     `fbase_key`, key `firebase:authUser:<apiKey>:[DEFAULT]`.
 */
export function buildIndexedDbInjectScript(user: Record<string, unknown>, apiKey: string): string {
  const userJson = JSON.stringify(user)
  const apiKeyJson = JSON.stringify(apiKey)
  // IIFE resolves once the IDB transaction commits, so the returned Promise
  // tracks the actual write.
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
  // Signals attach.ts's dom-ready patch to briefly hide documentElement so the
  // login page doesn't flash between rehydrate and redirect-to-workspace.
  try { sessionStorage.setItem('__comfyDesktopPostSignin', '1'); } catch (_) {}
  location.reload();
})()`
}
