/**
 * Firebase for the admin console — migration 0014.
 *
 * Deliberately the same project as the customer dashboard. Admin sign in with
 * the identity they already have, and `admin_users` in D1 decides what that
 * identity may do here. The console never asks Firebase what role somebody
 * holds and never reads a custom claim: a claim is minted into a token once and
 * would go stale on a demotion, whereas the row is read fresh on every request.
 *
 * ── One difference from apps/web, and it is on purpose ─────────────────────
 * `browserSessionPersistence`, not `browserLocalPersistence`. The dashboard
 * should survive a reload and a new tab, because that is an ordinary product
 * expectation. This console holds cross-tenant reach, so closing the tab should
 * end the session — the same reasoning that put the old admin token in
 * `sessionStorage` rather than `localStorage`, carried over to the mechanism
 * that replaced it.
 *
 * The config below is public by design: it names the project, it authorises
 * nothing. What stops a stranger using it is the project's authorised-domain
 * list, the API's `aud` check, and the admin row.
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  browserSessionPersistence,
  setPersistence
} from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

/**
 * Whether this build was given a project to talk to.
 *
 * Checked rather than assumed: a console built without these variables would
 * otherwise throw an SDK error on the sign-in button that nobody can act on.
 * The login screen says what is missing instead.
 */
export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

export const firebaseProjectId = config.projectId ?? null;

const app = firebaseConfigured ? initializeApp(config) : null;

export const auth = app ? getAuth(app) : null;

if (auth) {
  setPersistence(auth, browserSessionPersistence).catch(() => {
    /* A browser refusing storage still works, just for this page's lifetime. */
  });
}

export function googleProvider() {
  const provider = new GoogleAuthProvider();
  // Always show the chooser. A support engineer often has a personal and a work
  // Google account in the same browser, and silently reusing whichever signed
  // in last is how somebody ends up looking at customer data under the wrong
  // identity — which the audit log would then record as fact.
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

/**
 * The current ID token, refreshed when it is close to expiring.
 *
 * The SDK handles renewal; this just asks for the current one on every request
 * rather than caching it anywhere. Firebase ID tokens last about an hour, and a
 * token cached by us would be the one thing that could outlive a sign-out.
 */
export async function currentIdToken() {
  const user = auth?.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    // A refresh that fails means the session is gone — a disabled Firebase
    // account, a revoked refresh token, or no network. Returning null makes the
    // caller treat it as signed out, which is the honest reading.
    return null;
  }
}
