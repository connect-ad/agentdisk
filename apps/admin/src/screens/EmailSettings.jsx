import React, { useState } from 'react';
import { adminApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ErrorState, Skeleton } from '../components/States.jsx';
import {
  card,
  disabledBtn,
  input,
  label,
  mono,
  paneIn,
  pill,
  primaryBtn,
  secondaryBtn,
  textarea
} from '../lib/ui.js';

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
 * The message goes to the signed-in admin member's own address, decided
 * server-side from their `admin_users` row. There is deliberately no input
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
  const io = api ?? {
    read: adminApi.emailSettings,
    test: adminApi.testEmail,
    compose: adminApi.composeEmail
  };

  const { data, error, loading, refresh } = useResource(() => io.read());
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null);

  if (loading) return <Skeleton rows={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;

  const configured = data?.configured === true;
  // The console has one role now; `super_admin` is kept so an older token
  // still reads as permitted. The server re-checks either way.
  const permitted = role === 'admin' || role === 'super_admin';
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
            admin-initiated password reset. Sign-in links, address verification and self-service
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
            /* Says what it knows and stops. The screen sees one boolean from
               the Worker; it cannot tell a secret that was never set from one
               the deploy declined to push, and an earlier version of this copy
               asserted the first — sending somebody to check repository secrets
               that were sitting there correctly all along. The deploy log is
               where the reason actually is, so that is where it points. */
            <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--tx2)', marginTop: '7px' }}>
              This deployment has no email binding, so every send refuses.
              It comes from the <span style={mono}>send_email</span> block in the API&rsquo;s{' '}
              <span style={mono}>wrangler.toml</span> — check that the deployed Worker carries it.
            </div>
          )}
        </Row>
      </div>

      <div style={card}>
        <div style={{ padding: '15px 16px' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--tx)' }}>Send a test</div>
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--tx2)', marginTop: '5px' }}>
            Sends one message to your own admin address. There is no field for a recipient on
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
                Needs console access. You are signed in as {role}.
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
              Sent to <span style={mono}>{outcome.address}</span>. Cloudflare accepted it — check that
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
              a sender outside the binding&rsquo;s allowed addresses, a domain not onboarded to
              Email Sending, and the account&rsquo;s daily sending quota.
            </div>
          )}
        </div>
      </div>

      <ComposeCard
        configured={configured}
        permitted={permitted}
        defaultSender={data?.composeDefaultSender ?? 'noreply@agentdisk.io'}
        domain={data?.sendingDomain ?? 'agentdisk.io'}
        compose={io.compose}
        onToast={onToast}
      />
    </div>
  );
}

/** Email Service's ceiling for one message, attachments included. */
const MAX_BYTES = 5 * 1024 * 1024;

/** A File's bytes as base64, without the `data:` prefix. */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}

const notice = tone => ({
  border: `1px solid var(--${tone}Bd)`,
  background: `var(--${tone}Soft)`,
  borderRadius: '9px',
  padding: '11px 13px',
  fontSize: '12.5px',
  lineHeight: 1.6,
  color: `var(--${tone}Tx)`
});

/**
 * Compose - an operator writes a message and sends it through the same binding
 * as every other message in the product.
 *
 * The sender starts as `noreply@` and can be edited to any address on the
 * onboarded domain; the server refuses anything else, so the hint under the
 * field is a courtesy rather than the check. Every send is written to the
 * fleet log under the operator's name - sender, recipients, subject and
 * attachment names, never the body.
 */
function ComposeCard({ configured, permitted, defaultSender, domain, compose, onToast }) {
  const [from, setFrom] = useState(defaultSender);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState([]);
  const [fileKey, setFileKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null);

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const tooLarge = totalBytes > MAX_BYTES;
  const complete =
    from.trim() !== '' && to.trim() !== '' && subject.trim() !== '' && message.trim() !== '';
  const canSend =
    configured && permitted && complete && !tooLarge && !sending && typeof compose === 'function';

  function clearFiles() {
    setFiles([]);
    setFileKey(key => key + 1);
  }

  async function send(event) {
    event.preventDefault();
    if (!canSend) return;
    setSending(true);
    setOutcome(null);
    try {
      const attachments = await Promise.all(
        files.map(async file => ({
          filename: file.name,
          type: file.type || 'application/octet-stream',
          content: await readAsBase64(file)
        }))
      );
      const result = await compose({ from: from.trim(), to, subject, message, attachments });
      const recipients = (result?.to ?? []).join(', ');
      setOutcome({ kind: SENT, address: recipients });
      onToast(`Message sent to ${recipients}.`);
      setTo('');
      setSubject('');
      setMessage('');
      clearFiles();
    } catch (err) {
      setOutcome({ kind: FAILED, message: err?.message ?? 'The message could not be sent.' });
    } finally {
      setSending(false);
    }
  }

  const field = { display: 'grid', gap: '6px' };
  const hint = { fontSize: '12px', color: 'var(--tx2)' };

  return (
    <form style={card} onSubmit={send} aria-label="Compose email">
      <div style={{ padding: '15px 16px', display: 'grid', gap: '13px' }}>
        <div>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--tx)' }}>Compose</div>
          <div style={{ fontSize: '12.5px', lineHeight: 1.6, color: 'var(--tx2)', marginTop: '5px' }}>
            Sends through the same channel as above. Every send is recorded in the audit log with
            its sender, recipients, subject and attachment names.
          </div>
        </div>

        <label style={field}>
          <span style={label}>Sender email</span>
          <input
            style={{ ...input, ...mono }}
            type="email"
            value={from}
            onChange={e => setFrom(e.target.value)}
            aria-label="Sender email"
          />
          <span style={hint}>Any address on @{domain}.</span>
        </label>

        <label style={field}>
          <span style={label}>To</span>
          <input
            style={input}
            type="text"
            value={to}
            onChange={e => setTo(e.target.value)}
            placeholder="name@example.com, another@example.com"
            aria-label="To"
          />
        </label>

        <label style={field}>
          <span style={label}>Subject</span>
          <input style={input} type="text" value={subject} onChange={e => setSubject(e.target.value)} aria-label="Subject" />
        </label>

        <label style={field}>
          <span style={label}>Email message</span>
          <textarea
            style={{ ...textarea, height: '180px' }}
            value={message}
            onChange={e => setMessage(e.target.value)}
            aria-label="Email message"
          />
        </label>

        <label style={field}>
          <span style={label}>Attachment</span>
          <input
            key={fileKey}
            type="file"
            multiple
            onChange={e => setFiles(Array.from(e.target.files ?? []))}
            aria-label="Attachment"
            style={{ fontSize: '12.5px', color: 'var(--tx2)' }}
          />
          {files.length > 0 && (
            <span style={{ ...hint, color: tooLarge ? 'var(--dngrTx)' : 'var(--tx2)' }}>
              {files.length} file{files.length === 1 ? '' : 's'},{' '}
              {(totalBytes / (1024 * 1024)).toFixed(2)} MB
              {tooLarge ? ' - over the 5 MB limit for one message.' : ''}
            </span>
          )}
        </label>

        <div style={{ display: 'flex', alignItems: 'center', gap: '11px' }}>
          <button type="submit" disabled={!canSend} style={canSend ? primaryBtn : disabledBtn}>
            {sending ? 'Sending…' : 'Send email'}
          </button>
          {files.length > 0 && !sending && (
            <button type="button" style={secondaryBtn} onClick={clearFiles}>
              Remove attachments
            </button>
          )}
          {!configured && (
            <span style={{ fontSize: '12.5px', color: 'var(--tx2)' }}>
              Email is not configured in this deployment.
            </span>
          )}
        </div>

        {outcome?.kind === SENT && (
          <div style={notice('ok')}>
            Sent to <span style={mono}>{outcome.address}</span>. Cloudflare accepted it - acceptance
            is not delivery, so check the inbox.
          </div>
        )}

        {outcome?.kind === FAILED && <div style={notice('dngr')}>Failed - {outcome.message}</div>}
      </div>
    </form>
  );
}
