/**
 * Firebase client initialisation — doc 16 PART 30.
 *
 * This config is public by design: it identifies the project, it does not
 * authorise anything. What stops a stranger using it is the Firebase project's
 * own authorised-domain list plus the API's `aud` check, not secrecy. It still
 * comes from build-time environment variables rather than being hardcoded, so
 * a dev build cannot point at the prod project by accident — dev and prod are
 * two separate Firebase projects precisely so that mistake is impossible to
 * make silently.
 */

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  GithubAuthProvider,
  browserLocalPersistence,
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
 * Checked rather than assumed because the marketing pages must still render on
 * a build without it. Sign-in surfaces say so plainly instead of throwing an
 * SDK error nobody can act on.
 */
export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId);

export const firebaseProjectId = config.projectId ?? null;

const app = firebaseConfigured ? initializeApp(config) : null;

export const auth = app ? getAuth(app) : null;

if (auth) {
  // Survive a reload and a new tab. The SDK holds the refresh token here and
  // renews the ID token silently; this app never sees or stores either.
  setPersistence(auth, browserLocalPersistence).catch(() => {
    /* A browser refusing storage still works, just per-tab. Not fatal. */
  });
}

export function googleProvider() {
  const provider = new GoogleAuthProvider();
  // Always show the chooser. Without it a shared machine silently reuses
  // whichever Google account signed in last, which reads as a bug.
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

export function githubProvider() {
  const provider = new GithubAuthProvider();
  // Identity only. AgentDisk has no reason to read anyone's repositories, and
  // asking for scopes you do not use is how a consent screen loses trust.
  provider.addScope('read:user');
  return provider;
}
