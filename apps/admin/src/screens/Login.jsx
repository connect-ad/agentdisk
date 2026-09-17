import React, { useState } from 'react';
import { staffApi, storeToken } from '../api.js';
import { card, input, label, mono, primaryBtn } from '../lib/ui.js';

/**
 * Staff sign-in.
 *
 * All three factors go in one request. The server never reveals whether the
 * password was right before the code is also checked — a login that answered
 * "wrong code" would confirm the password, turning the second factor into a
 * progress bar for whoever is guessing. The single failure message below is the
 * client half of that; the server refuses identically either way.
 *
 * No signup link and no self-service reset, deliberately. Staff accounts are
 * created by a super_admin inside the console, or for the very first one by
 * `scripts/provision-staff.mjs`.
 *
 * Corrections from the design file: sessions are FOUR hours, not eight, and
 * this is `agentdisk.io`, not `agentdisk.dev`.
 */
export function Login({ onSignedIn, reason = null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await staffApi.login(email.trim(), password, totp.trim());
      storeToken(result.token);
      onSignedIn(result.staff);
    } catch (err) {
      // One message for every failure mode, matching the server.
      setError(err.status === 429 ? err.message : 'Those details were not accepted.');
      setPassword('');
      setTotp('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 24px'
      }}
    >
      <div style={{ width: 'min(368px, 100%)' }}>
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

        <form onSubmit={submit} style={{ ...card, padding: '24px' }}>
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
            Internal use only. Access is logged against your staff account.
          </p>

          {reason && (
            <div
              style={{
                border: '1px solid var(--warnBd)',
                background: 'var(--warnSoft)',
                borderRadius: '9px',
                padding: '10px 12px',
                marginBottom: '16px',
                fontSize: '12.5px',
                color: 'var(--warnTx)'
              }}
            >
              {reason}
            </div>
          )}

          <label htmlFor="staff-email" style={label}>
            Staff email
          </label>
          <input
            id="staff-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={event => setEmail(event.target.value)}
            style={{ ...input, marginBottom: '14px' }}
          />

          <label htmlFor="staff-password" style={label}>
            Password
          </label>
          <input
            id="staff-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={event => setPassword(event.target.value)}
            style={{ ...input, marginBottom: '14px' }}
          />

          <label htmlFor="staff-totp" style={label}>
            2FA code
          </label>
          <input
            id="staff-totp"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            value={totp}
            onChange={event => setTotp(event.target.value.replace(/\D/g, ''))}
            style={{ ...input, ...mono, letterSpacing: '0.3em', marginBottom: '20px' }}
          />

          {error && (
            <div
              role="alert"
              style={{
                border: '1px solid var(--dngrBd)',
                background: 'var(--dngrSoft)',
                borderRadius: '9px',
                padding: '10px 12px',
                marginBottom: '16px',
                fontSize: '12.5px',
                color: 'var(--dngrTx)'
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            style={{ ...primaryBtn, width: '100%', height: '44px', fontSize: '14px' }}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p
            style={{
              margin: '14px 0 0',
              fontSize: '11.5px',
              lineHeight: 1.55,
              color: 'var(--tx3)',
              textAlign: 'center'
            }}
          >
            2FA is mandatory for all staff accounts. Sessions expire after 4 hours.
          </p>
        </form>
      </div>
    </div>
  );
}
