import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHead, Panel, Input, Button, Alert } from '../components/index.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * Support, from `AgentDisk Dashboard.dc.html`.
 *
 * ── What "Send request" does ──────────────────────────────────────────────
 * `POST /v1/support`: one email to the support inbox, from the product's web
 * support sender, with the signed-in person's address as Reply-To. The body
 * names who asked (the *verified* email, taken from the credential rather than
 * from anything this screen sends), the topic as it is worded below, the
 * workspace, then the subject and message. Until 26 September 2026 there was
 * nothing behind this form and it said so; that banner is gone with the reason
 * for it.
 *
 * The button is disabled until both fields hold something, and while a send is
 * in flight, so a double click cannot send twice. Success clears the form for
 * the same reason. A refusal is shown and the text kept: losing what somebody
 * typed after an agent has been failing for an hour is the `backlog/023`
 * failure at its worst, on the one screen people reach when something is
 * already wrong.
 *
 * ── What is still not rendered ────────────────────────────────────────────
 * The design's "Priority · replies within 1 hour" line. Mail reaches an inbox
 * a person reads in working hours; an hour is a commitment the product cannot
 * keep, so it is not made. The design's auto-generated audit export is not
 * built either; the paragraph under the form points at the activity log, which
 * is a real destination.
 */

/**
 * The topics, and the words shown for each. The API holds the same table
 * (`SUPPORT_TOPICS` in `lib/email.ts`) and refuses an id it does not know, so
 * adding one here without adding it there is a 400 on the new choice.
 */
const TOPICS = [
  { id: 'billing', label: 'Billing or invoices' },
  { id: 'keys', label: 'Key or scope problem' },
  { id: 'errors', label: 'Agent hitting 5xx' },
  { id: 'other', label: 'Something else' },
];

export default function Support() {
  const { ws } = useParams();
  const { api, workspaceId } = useWorkspace();
  const [topic, setTopic] = useState('errors');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);

  const canSend = subject.trim() !== '' && body.trim() !== '' && !sending;

  async function submit(e) {
    e?.preventDefault?.();
    if (!canSend) return;
    setSending(true);
    setError(null);
    setSent(false);
    try {
      await api.sendSupportRequest(workspaceId, {
        topic,
        subject: subject.trim(),
        message: body.trim(),
      });
      setSent(true);
      setSubject('');
      setBody('');
    } catch (err) {
      setError(err?.message ?? 'The request could not be sent. Nothing was lost — try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="acct acct--support">
      <PageHead
        title="Support"
        subtitle="Tell us what broke and we will look at the same logs you can see."
      />

      {sent ? (
        <Alert tone="ok" title="Sent">
          Your request is in the support inbox. We reply to the address you are
          signed in with, in working hours, in the order it arrives.
        </Alert>
      ) : null}
      {error ? <Alert tone="danger" title={error} /> : null}

      <Panel title="What do you need help with?">
        <div className="sup__topics" role="radiogroup" aria-label="What do you need help with?">
          {TOPICS.map(t => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={t.id === topic}
              className={t.id === topic ? 'sup__topic is-on' : 'sup__topic'}
              onClick={() => setTopic(t.id)}
            >
              <span className={t.id === topic ? 'sup__radio is-on' : 'sup__radio'} aria-hidden="true" />
              <span className="sup__topiclabel">{t.label}</span>
            </button>
          ))}
        </div>
      </Panel>

      <form onSubmit={submit}>
        <Panel
          title="Describe the problem"
          footer={
            <>
              <Button type="submit" disabled={!canSend} loading={sending}>
                {sending ? 'Sending…' : 'Send request'}
              </Button>
              <span className="ad-meta">Goes to the people who built this, from your signed-in address</span>
            </>
          }
        >
          <Input
            label="Subject"
            value={subject}
            onChange={e => setSubject(e.target.value)}
            hint="One line. What is failing, and since when."
          />
          <Input
            label="What happened"
            multiline
            rows={5}
            value={body}
            onChange={e => setBody(e.target.value)}
            hint="Include a path, a key's last four characters, and a timestamp if you have one."
          />
          {/*
            The design attaches an auto-generated audit export. Nothing exports an
            audit bundle today, so instead this points at the log the person can
            already read and copy from — which is a real destination.
          */}
          <p className="ad-small ad-measure">
            Your workspace's <Link to={`/w/${ws}/activity`}>activity log</Link> records
            every call, including the denied ones and the scope they needed. That is
            usually the fastest thing to quote.
          </p>
        </Panel>
      </form>
    </div>
  );
}
