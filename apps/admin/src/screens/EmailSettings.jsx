import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ErrorState, Skeleton } from '../components/States.jsx';
import { card, disabledBtn, label, mono, paneIn, pill, primaryBtn } from '../lib/ui.js';

/**
 * Email delivery — status, and a test send.
 *
 * ── Why a screen for one button ────────────────────────────────────────────
 * Before this, the only way to find out whether outbound email worked in a
 * deployment was to run a real password reset on a real customer and ask them
 * whether it arrived. That test needs a willing customer, sends them a live
 * credential they did not ask for, and can only be run at the moment somebody
 * already needs it to work.
 *
 * ── The screen does not decide whether it is configured ────────────────────
 * `configured` comes from the API, because the credentials live in the Worker
 * and never leave it — the browser cannot work this out and must not guess. A
 * screen that guessed would offer a button that fails, which teaches an
 * operator that the console's controls are suggestions.
 *
 * ── It does not choose the recipient, and there is no field for one ─────────
 * The message goes to the signed-in staff member's own address, decided
 * server-side from their `staff_users` row. There is deliberately no input
 * here: a test-send form that takes an address is an open relay wearing a
 * friendly label, sending from a domain whose SPF and DKIM already align.
 *
 * ── Firebase's mail is not covered, and the screen says so ─────────────────
 * Sign-in links, address verification and self-service password reset are sent
 * by Firebase from its own infrastructure and never touch this channel. Left
 * unsaid, somebody reading "Email delivery: configured" would reasonably
 * conclude sign-up mail was covered by this check. It is not.
 */

const SENT = 'sent';
const FAILED = 'failed';

function Row({ name, children }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '160px minmax(0,1fr)',
        gap: '14px',
        alignItems: 'baseline',
        padding: '13px 16px',
        borderTop: '1px solid var(--bd)'
      }}
    >
      <span style={label}>{name}</span>
      <span style={{ fontSize: '13px', color: 'var(--tx)' }}>{children}</span>
    </div>
  );
}

export function EmailSettings({ role, onToast, api }) {
  const io = api ?? { read: staffApi.emailSettings, test: staffApi.testEmail };

  const { data, error, loading, refresh } = useResource(() => io.read());
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null);

  if (loading) return <Skeleton rows={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;

  const configured = data?.configured === true;
  const permitted = role === 'super_admin';
  const canSend = configured && permitted && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setOutcome(null);
    try {
      const result = await io.test();
      setOutcome({ kind: SENT, address: result.sentTo });
      onToast(`Test message sent to ${result.sentTo}.`);
    } catch (err) {
      // Shown on the screen as well as toasted. A toast disappears, and this is
      // the one thing somebody opened this screen to find out.
      setOutcome({ kind: FAILED, message: err?.message ?? 'The test message could not be sent.' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ ...paneIn, display: 'grid', gap: '16px', maxWidth: '720px' }}>
      <div style={card}>
        <div style={{ padding: '15px 16px' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--tx)' }}>
            Outbound email
          </div>
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--tx2)', marginTop: '5px' }}>
            The channel this product sends its own transactional mail through — today, the
            staff-initiated password reset. Sign-in links, address verification and self-service
            password reset are sent by Firebase and are not covered by this check.
          </div>
        </div>

        <Row name="Provider">{data?.provider ?? 'unknown'}</Row>

        <Row name="Sends from">
          <span style={mono}>{data?.sender ?? 'unknown'}</span>
        </Row>

        <Row name="Credentials">
          {/* A word, not only a tone - nothing in this console states a status by
              colour alone, because a colour is unreadable to some people and
              ambiguous to everybody else. */}
          <span
            style={
              configured
                ? pill('var(--okTx)', 'var(--okSoft)', 'var(--okBd)')
                : pill('var(--warnTx)', 'var(--warnSoft)', 'var(--warnBd)')
            }
          >
            {configured ? 'Configured' : 'Not configured'}
          </span>
          {!configured && (
            <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--tx2)', marginTop: '7px' }}>
              This deployment has no Mailjet credentials, so every send refuses. They are pushed by
              CI with <span style={mono}>wrangler secret put</span>; a half-set key pair counts as
              absent, because the Send API uses the two as one credential.
            </div>
          )}
        </Row>
      </div>

      <div style={card}>
        <div style={{ padding: '15px 16px' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--tx)' }}>Send a test</div>
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--tx2)', marginTop: '5px' }}>
            Sends one message to your own staff address. There is no field for a recipient on
            purpose — an endpoint that emails an address on request is a relay, not a test.
          </div>

          <div style={{ marginTop: '13px', display: 'flex', alignItems: 'center', gap: '11px' }}>
            <button
              type="button"
              onClick={send}
              disabled={!canSend}
              style={canSend ? primaryBtn : disabledBtn}
            >
              {sending ? 'Sending…' : 'Send a test message'}
            </button>

            {!permitted && (
              <span style={{ fontSize: '12.5px', color: 'var(--tx2)' }}>
                Needs super_admin. You are signed in as {role}.
              </span>
            )}
          </div>

          {outcome?.kind === SENT && (
            <div
              style={{
                marginTop: '13px',
                border: '1px solid var(--okBd)',
                background: 'var(--okSoft)',
                borderRadius: '9px',
                padding: '11px 13px',
                fontSize: '12.5px',
                lineHeight: 1.6,
                color: 'var(--okTx)'
              }}
            >
              Sent to <span style={mono}>{outcome.address}</span>. Mailjet accepted it — check that
              mailbox to confirm it arrived, since acceptance is not delivery.
            </div>
          )}

          {outcome?.kind === FAILED && (
            <div
              style={{
                marginTop: '13px',
                border: '1px solid var(--dngrBd)',
                background: 'var(--dngrSoft)',
                borderRadius: '9px',
                padding: '11px 13px',
                fontSize: '12.5px',
                lineHeight: 1.6,
                color: 'var(--dngrTx)'
              }}
            >
              Failed — {outcome.message} The reason is in the Worker log; the most common causes are
              a key pair that is wrong or inactive, and a sender address not verified in Mailjet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
