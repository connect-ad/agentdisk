import React, { useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import { auth, firebaseConfigured, firebaseProjectId, googleProvider } from '../lib/firebase.js';
import { card, mono, primaryBtn } from '../lib/ui.js';

/**
 * Staff sign-in.
 *
 * One button. There is no staff password and no staff TOTP any more — Firebase
 * owns authentication, and `staff_users` in D1 owns authorisation. Signing in
 * here proves only WHO you are; whether that identity is staff is decided by
 * the API on the first request afterwards.
 *
 * ── Signing in is not the same as being let in ─────────────────────────────
 * Anybody with a Google account can complete this. That is not a hole: they
 * arrive authenticated and immediately fail `requireStaff`, and the screen
 * below says so plainly rather than looping them back to a sign-in button that
 * appears not to work. The alternative — hiding the button from non-staff —
 * would require knowing who is staff before anybody has authenticated, which is
 * the thing we cannot know.
 *
 * ── No signup, no password reset, no email link ────────────────────────────
 * All three belong to the customer dashboard. A staff member is an address
 * somebody with super_admin added to a table; there is nothing here to enrol
 * in or recover.
 */
export function Login({ notStaff = null, error: upstreamError = null, onSignedIn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function signIn() {
    if (busy || !auth) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider());
      // The shell re-checks with the API; this screen deliberately does not
      // decide whether they are staff.
      onSignedIn?.();
    } catch (err) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') {
        // Closing the popup is a decision, not a failure.
        setError(null);
      } else if (err?.code === 'auth/unauthorized-domain') {
        setError(
          `This origin is not in the Firebase project's authorised domains. Add it under ` +
            `Authentication → Settings → Authorized domains in the ${firebaseProjectId} project.`
        );
      } else {
        setError(err?.message ?? 'Sign-in failed.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        // Percentage, never `100vh` -- app.css's full-height chain says why.
        minHeight: '100%',
        background: 'var(--bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px'
      }}
    >
      <div style={{ width: 'min(400px, 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '26px' }}>
          <span
            style={{
              fontFamily: 'var(--fontHead)',
              fontSize: '16px',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              color: 'var(--tx)'
            }}
          >
            AgentDisk
          </span>
          <span
            style={{
              ...mono,
              fontSize: '9px',
              letterSpacing: '0.1em',
              color: 'var(--warnTx)',
              background: 'var(--warnSoft)',
              border: '1px solid var(--warnBd)',
              borderRadius: '4px',
              padding: '2px 6px'
            }}
          >
            STAFF
          </span>
        </div>

        <div style={{ ...card, padding: '24px' }}>
          <h1
            style={{
              margin: '0 0 6px',
              fontFamily: 'var(--fontHead)',
              fontSize: '21px',
              fontWeight: 600,
              letterSpacing: '-0.025em',
              color: 'var(--tx)'
            }}
          >
            Staff sign-in
          </h1>
          <p style={{ margin: '0 0 22px', fontSize: '13px', lineHeight: 1.55, color: 'var(--tx2)' }}>
            Internal use only. Everything you do here is logged against your account.
          </p>

          {!firebaseConfigured && (
            <div
              role="alert"
              style={{
                border: '1px solid var(--dngrBd)',
                background: 'var(--dngrSoft)',
                borderRadius: '9px',
                padding: '12px',
                fontSize: '12.5px',
                lineHeight: 1.55,
                color: 'var(--dngrTx)'
              }}
            >
              This build has no Firebase project. Set the <span style={mono}>VITE_FIREBASE_*</span>{' '}
              variables and redeploy — sign-in cannot work without them.
            </div>
          )}

          {/*
            The case that actually happens: somebody signs in with a perfectly
            good Google account that has no staff row. Saying so is the whole
            point - the alternative is a button that appears not to work.
          */}
          {notStaff && (
            <div
              role="alert"
              style={{
                border: '1px solid var(--warnBd)',
                background: 'var(--warnSoft)',
                borderRadius: '9px',
                padding: '12px',
                marginBottom: '16px',
                fontSize: '12.5px',
                lineHeight: 1.6,
                color: 'var(--warnTx)'
              }}
            >
              <strong>{notStaff}</strong> is signed in, but has no staff access.
              <div style={{ marginTop: '6px' }}>
                Ask a super_admin to add this address under Staff Accounts, or sign in with a
                different one.
              </div>
            </div>
          )}

          {/*
            Distinct from `notStaff`: we could not ASK whether they are staff.
            Saying so keeps somebody from hunting for a missing database row.
          */}
          {upstreamError && (
            <div
              role="alert"
              style={{
                border: '1px solid var(--dngrBd)',
                background: 'var(--dngrSoft)',
                borderRadius: '9px',
                padding: '12px',
                marginBottom: '16px',
                fontSize: '12.5px',
                lineHeight: 1.6,
                color: 'var(--dngrTx)'
              }}
            >
              <strong>The API could not be reached.</strong> This is not a problem with your
              account — your staff access could not be checked at all.
              <div style={{ ...mono, marginTop: '6px', fontSize: '11px' }}>
                {upstreamError.code ?? 'NETWORK'}
                {upstreamError.status ? ` · ${upstreamError.status}` : ''}
                {upstreamError.requestId ? ` · ${upstreamError.requestId}` : ''}
              </div>
            </div>
          )}

          {firebaseConfigured && (
            <button
              type="button"
              onClick={signIn}
              disabled={busy}
              style={{ ...primaryBtn, width: '100%', height: '44px', fontSize: '14px' }}
            >
              {busy ? 'Opening Google…' : notStaff ? 'Sign in as someone else' : 'Sign in with Google'}
            </button>
          )}

          {error && (
            <div
              role="alert"
              style={{
                border: '1px solid var(--dngrBd)',
                background: 'var(--dngrSoft)',
                borderRadius: '9px',
                padding: '10px 12px',
                marginTop: '16px',
                fontSize: '12.5px',
                lineHeight: 1.55,
                color: 'var(--dngrTx)'
              }}
            >
              {error}
            </div>
          )}

          <p
            style={{
              margin: '14px 0 0',
              fontSize: '11.5px',
              lineHeight: 1.55,
              color: 'var(--tx3)',
              textAlign: 'center'
            }}
          >
            Signing in proves who you are. What you may do here is decided by your staff record.
          </p>
        </div>
      </div>
    </div>
  );
}
