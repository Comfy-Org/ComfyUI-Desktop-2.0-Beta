/**
 * Firebase project configs mirroring the cloud frontend's
 * `src/config/firebase.ts`. The values are public (apiKey is a
 * project identifier, not a secret) so hardcoding them here is fine.
 *
 * `prod` is used when the embedded cloud-workspace view opens a
 * popup whose host is `dreamboothy.firebaseapp.com`; `dev` for
 * `dreamboothy-dev.firebaseapp.com`.
 */
export interface FirebaseProjectConfig {
  apiKey: string
  authDomain: string
  databaseURL: string
  projectId: string
  storageBucket: string
  messagingSenderId: string
  appId: string
}

export type FirebaseEnv = 'prod' | 'dev'

const PROD_CONFIG: FirebaseProjectConfig = {
  apiKey: 'AIzaSyC2-fomLqgCjb7ELwta1I9cEarPK8ziTGs',
  authDomain: 'dreamboothy.firebaseapp.com',
  databaseURL: 'https://dreamboothy-default-rtdb.firebaseio.com',
  projectId: 'dreamboothy',
  storageBucket: 'dreamboothy.appspot.com',
  messagingSenderId: '357148958219',
  appId: '1:357148958219:web:f5917f72e5f36a2015310e',
}

const DEV_CONFIG: FirebaseProjectConfig = {
  apiKey: 'AIzaSyDa_YMeyzV0SkVe92vBZ1tVikWBmOU5KVE',
  authDomain: 'dreamboothy-dev.firebaseapp.com',
  databaseURL: 'https://dreamboothy-dev-default-rtdb.firebaseio.com',
  projectId: 'dreamboothy-dev',
  storageBucket: 'dreamboothy-dev.appspot.com',
  messagingSenderId: '313257147182',
  appId: '1:313257147182:web:be38f6ebf74345fc7618bf',
}

export function getFirebaseConfig(env: FirebaseEnv): FirebaseProjectConfig {
  return env === 'dev' ? DEV_CONFIG : PROD_CONFIG
}

/**
 * Decide which Firebase project the intercepted popup URL points at.
 * The URL is always one of the auth-handler URLs we already match in
 * `isFirebaseAuthHandlerUrl`, so the host check is the source of truth.
 */
export function detectFirebaseEnv(url: string): FirebaseEnv {
  try {
    const host = new URL(url).host
    if (host === DEV_CONFIG.authDomain) return 'dev'
    return 'prod'
  } catch {
    return 'prod'
  }
}
