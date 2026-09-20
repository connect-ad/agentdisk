/**
 * The signed-in person, and the four ways to become one — doc 16 PART 30,
 * doc 03 §8.3–8.7.
 *
 * Google, GitHub, email/password and email-link all ship together rather than
 * being staged across MVP tiers: Firebase makes them equally cheap, so staging
 * them would be an arbitrary restriction rather than a saving.
 *
 * Error handling has one rule that outranks convenience: **a sign-in failure
 * never says which half was wrong.** Firebase distinguishes `user-not-found`
 * from `wrong-password`; surfacing that difference turns the login form into an
 * oracle for whether an address has an account here. They are collapsed into
 * one message, matching what the API does for a bad API key.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  verifyPasswordResetCode,
  confirmPasswordReset,
  onIdTokenChanged,
  updateProfile,
  verifyBeforeUpdateEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider
} from 'firebase/auth';
import { auth, firebaseConfigured, googleProvider, githubProvider } from './firebase.js';
import { POLICY_SENTENCE } from './password.js';

const AuthContext = createContext(null);

/** Where Firebase sends an email-link recipient back to. */
const EMAIL_LINK_REDIRECT = `${window.location.origin}/login`;

/** The address is remembered so the returning link does not have to ask again. */
const EMAIL_LINK_KEY = 'agentdisk.emailLink.address';

const GENERIC_SIGNIN_FAILURE =
  "That email and password don't match an account. Check both and try again.";

/**
 * Turn a Firebase error into something a person can act on, without saying more
 * than they are entitled to know.
 *
 * `context` exists for one narrow reason. Collapsing "no such account" into
 * "wrong password" is what stops the *login* form being an oracle for which
 * addresses are registered here. Re-authenticating somebody who is already
 * signed in reveals nothing — we and they both already know the account exists —
 * so there the collapse only makes a wrong password unactionable. Pass
 * 'reauth' in that case and nowhere else.
 */
export function describeAuthError(error, context = 'signin') {
  const code = error?.code ?? '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-email':
    case 'auth/user-not-found':
    case 'auth/wrong-password':
      return context === 'reauth'
        ? "That current password isn't right. Check it and try again."
        : GENERIC_SIGNIN_FAILURE;
    case 'auth/requires-recent-login':
      return 'For your security, sign out and sign back in before changing this.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes before trying again.';
    case 'auth/email-already-in-use':
      // Unavoidable on signup - the account cannot be created either way, and
      // saying nothing leaves the person stuck on a form that will never work.
      return 'That email already has an account. Try signing in instead.';
    // Both of these are the password policy refusing, from either side of the
    // upgrade: `weak-password` is the old minimum-length rejection,
    // `password-does-not-meet-requirements` is what the configured policy
    // returns. Neither can be collapsed into the generic failure — this is the
    // one class of error the person can fix from the form they are looking at,
    // and the default below would send them back to retype the same password.
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return `That password does not meet the requirements. ${POLICY_SENTENCE}`;
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return null; // They changed their mind. Not an error worth showing.
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'That email is already registered with a different sign-in method. Use the one you signed up with.';
    case 'auth/unauthorized-domain':
      return 'This site is not an authorised sign-in domain for the Firebase project.';
    case 'auth/network-request-failed':
      return 'Could not reach the sign-in service. Check your connection and try again.';
    default:
      return 'Something went wrong signing you in. Try again.';
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(firebaseConfigured);
  // Firebase mutates the User object in place, so a profile edit changes
  // nothing React can see. This counter is what says 'the object you are
  // already holding is different now'.
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => {
    if (!auth) return undefined;
    // onIdTokenChanged rather than onAuthStateChanged: it also fires on the
    // SDK's silent hourly token refresh, so anything reading the token stays
    // current instead of holding one that quietly expired.
    return onIdTokenChanged(auth, next => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      configured: firebaseConfigured,

      /** The current ID token, refreshed by the SDK when it needs to be. */
      async getToken() {
        if (!auth?.currentUser) return null;
        return auth.currentUser.getIdToken();
      },

      async signInWithPassword(email, password) {
        await signInWithEmailAndPassword(auth, email, password);
      },

      /**
       * `displayName` is optional because Google and GitHub supply one of
       * their own; the email form is the only path that has to ask. It is set
       * before the verification mail goes out so the address the person
       * confirms already belongs to a named account — a members list and an
       * activity row both read this claim, and an account with only an email
       * address in them is the thing the signup form exists to avoid.
       *
       * A failure to set it is swallowed on purpose: the account exists by
       * that point, and rejecting the signup over a cosmetic claim would
       * leave somebody with a working credential and an error message. The
       * name is editable from Profile either way.
       */
      async signUpWithPassword(email, password, displayName) {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        const name = displayName?.trim();
        if (name) {
          try {
            await updateProfile(credential.user, { displayName: name });
          } catch {
            /* Cosmetic. Profile can set it later. */
          }
        }
        // Fired here rather than left to a later screen: an unverified address
        // cannot claim an invitation on the API side, so the sooner it is
        // verified the sooner the account behaves as the person expects.
        await sendEmailVerification(credential.user);
      },

      async signInWithGoogle() {
        await signInWithPopup(auth, googleProvider());
      },

      async signInWithGithub() {
        await signInWithPopup(auth, githubProvider());
      },

      async sendEmailLink(email) {
        await sendSignInLinkToEmail(auth, email, {
          url: EMAIL_LINK_REDIRECT,
          handleCodeInApp: true
        });
        try {
          window.localStorage.setItem(EMAIL_LINK_KEY, email);
        } catch {
          /* Private mode. The returning screen asks for the address instead. */
        }
      },

      /** True when the current URL is a Firebase email-link landing. */
      isEmailLink(href) {
        return Boolean(auth) && isSignInWithEmailLink(auth, href ?? window.location.href);
      },

      async completeEmailLink(href, fallbackEmail) {
        let email = fallbackEmail ?? null;
        if (!email) {
          try {
            email = window.localStorage.getItem(EMAIL_LINK_KEY);
          } catch {
            email = null;
          }
        }
        if (!email) {
          const wanted = new Error('email address required to complete sign-in');
          wanted.code = 'agentdisk/email-link-needs-address';
          throw wanted;
        }
        await signInWithEmailLink(auth, email, href ?? window.location.href);
        try {
          window.localStorage.removeItem(EMAIL_LINK_KEY);
        } catch {
          /* nothing to clean up */
        }
      },

      async sendReset(email) {
        await sendPasswordResetEmail(auth, email);
      },

      /**
       * Check the one-time code from a reset email before showing the form, so
       * an expired link says so immediately rather than after somebody has
       * typed a new password twice. Resolves to the address it belongs to.
       */
      async verifyResetCode(code) {
        return verifyPasswordResetCode(auth, code);
      },

      async confirmReset(code, password) {
        await confirmPasswordReset(auth, code, password);
      },

      async resendVerification() {
        if (auth?.currentUser) await sendEmailVerification(auth.currentUser);
      },

      /**
       * The display name is stored in Firebase and nowhere else — the API reads
       * it from the `name` claim rather than keeping its own copy — so this is
       * the whole of the change, not the client half of one.
       */
      async updateDisplayName(displayName) {
        if (!auth?.currentUser) throw new Error('not signed in');
        await updateProfile(auth.currentUser, { displayName });
        // Force a refresh so the claim the API reads is the new one, and bump
        // the counter so anything showing the name re-renders.
        await auth.currentUser.getIdToken(true);
        setProfileVersion(v => v + 1);
      },

      /**
       * The sign-in methods this account actually has, as Firebase provider
       * ids ('password', 'google.com', 'github.com'). The Security screen reads
       * this rather than assuming: an account created with Google has no
       * password to change, and offering a change-password form to one is the
       * same class of lie as a hardcoded workspace ID.
       */
      providerIds: (user?.providerData ?? []).map(p => p.providerId),

      /**
       * Change the password, Firebase-side. There is no AgentDisk endpoint
       * behind this and there must not be: doc 16 PART 30 is explicit that the
       * Worker never receives, stores or sees a password.
       *
       * Firebase requires a recent login before it will accept the change, so
       * the current password is re-submitted here as a re-authentication rather
       * than verified by us. That is also what makes the "current password"
       * field meaningful instead of decorative.
       */
      async changePassword(currentPassword, newPassword) {
        const current = auth?.currentUser;
        if (!current) throw new Error('not signed in');
        if (!current.email) {
          throw new Error('this account has no email address to re-authenticate with');
        }
        await reauthenticateWithCredential(
          current,
          EmailAuthProvider.credential(current.email, currentPassword)
        );
        await updatePassword(current, newPassword);
      },

      /**
       * `verifyBeforeUpdateEmail`, not `updateEmail`: the address only moves
       * once the person has proved they can read mail at it, so a typo cannot
       * lock anybody out of their own account. The API picks the new address up
       * from the token on the next request — user-lookup.ts already syncs it.
       */
      async requestEmailChange(email) {
        if (!auth?.currentUser) throw new Error('not signed in');
        await verifyBeforeUpdateEmail(auth.currentUser, email);
      },

      async signOut() {
        if (auth) await fbSignOut(auth);
      }
    }),
    [user, loading, profileVersion]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}
