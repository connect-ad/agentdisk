import React from 'react';
import { card, mono, primaryBtn, secondaryBtn } from '../lib/ui.js';

/**
 * The states the design file never drew.
 *
 * The mockup has skeletons and nothing else: no empty state, no failed fetch,
 * no 403, no expired session. Those are not edge cases in a staff console —
 * they are most of what a support engineer actually meets, because the whole
 * job is looking at accounts that are in a bad state, and because a four-hour
 * session with no rotation guarantees expiry mid-task.
 */

export function Skeleton({ rows = 6 }) {
  return (
    <div style={card} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '14px',
            padding: '12px 14px',
            borderBottom: '1px solid var(--bd)'
          }}
        >
          {[180, 90, 220, 70].map((width, cell) => (
            <span
              key={cell}
              style={{
                height: '10px',
                width: `${width}px`,
                maxWidth: '40%',
                borderRadius: '4px',
                background: 'var(--surf3)',
                animation: 'adminShimmer 1.4s ease-in-out infinite',
                animationDelay: `${(index * 4 + cell) * 0.04}s`
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, detail, action = null }) {
  return (
    <div style={{ ...card, padding: '40px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--tx)', marginBottom: '6px' }}>
        {title}
      </div>
      {detail && (
        <p
          style={{
            margin: '0 auto',
            maxWidth: '440px',
            fontSize: '12.5px',
            lineHeight: 1.6,
            color: 'var(--tx2)'
          }}
        >
          {detail}
        </p>
      )}
      {action && <div style={{ marginTop: '16px' }}>{action}</div>}
    </div>
  );
}

/**
 * A failed fetch, with what actually failed.
 *
 * The request id is shown deliberately. It is the one thing that lets somebody
 * reading this screen find the matching line in the Worker's logs, and asking
 * an operator to reproduce a transient failure to get it is a waste of their
 * afternoon.
 */
export function ErrorState({ error, onRetry }) {
  if (!error) return null;

  const forbidden = error.status === 403;

  return (
    <div
      role="alert"
      style={{
        border: `1px solid ${forbidden ? 'var(--warnBd)' : 'var(--dngrBd)'}`,
        background: forbidden ? 'var(--warnSoft)' : 'var(--dngrSoft)',
        borderRadius: '11px',
        padding: '16px'
      }}
    >
      <div
        style={{
          ...mono,
          fontSize: '9.5px',
          letterSpacing: '0.11em',
          color: forbidden ? 'var(--warnTx)' : 'var(--dngrTx)',
          marginBottom: '8px'
        }}
      >
        {forbidden ? 'NOT PERMITTED FOR YOUR ROLE' : `FAILED · ${error.code ?? 'ERROR'}`}
      </div>
      <div
        style={{
          fontSize: '13px',
          lineHeight: 1.55,
          color: forbidden ? 'var(--warnTx)' : 'var(--dngrTx)'
        }}
      >
        {error.message}
      </div>
      {forbidden && (
        <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--tx2)' }}>
          The server refused this, not the interface. Ask a colleague with a higher role.
        </div>
      )}
      {error.requestId && (
        <div style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)', marginTop: '10px' }}>
          request {error.requestId}
        </div>
      )}
      {onRetry && !forbidden && (
        <button type="button" onClick={onRetry} style={{ ...secondaryBtn, marginTop: '12px' }}>
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The session ended mid-task.
 *
 * It keeps the route. A staff session is four hours with no refresh rotation,
 * so this is going to happen to somebody halfway through reading a workspace,
 * and a silent redirect to the login screen would lose where they were and
 * quietly discard whatever they had typed.
 */
export function SessionExpired({ onReauthenticate }) {
  return (
    <div
      role="alertdialog"
      aria-label="Session expired"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 'var(--z-modal)',
        background: 'rgba(0,0,0,.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px'
      }}
    >
      <div style={{ ...card, maxWidth: '420px', padding: '24px' }}>
        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--tx)', marginBottom: '8px' }}>
          Your staff session expired
        </div>
        <p style={{ margin: '0 0 18px', fontSize: '13px', lineHeight: 1.6, color: 'var(--tx2)' }}>
          Staff sessions last four hours and are not renewed automatically. Sign in again and you
          will come back to this same screen.
        </p>
        <button type="button" onClick={onReauthenticate} style={{ ...primaryBtn, width: '100%' }}>
          Sign in again
        </button>
      </div>
    </div>
  );
}

/** A value the product does not record. Never a zero standing in for one. */
export function NotTracked({ children = 'not tracked yet' }) {
  return (
    <span style={{ ...mono, fontSize: '11px', color: 'var(--tx3)', fontStyle: 'italic' }}>
      {children}
    </span>
  );
}
