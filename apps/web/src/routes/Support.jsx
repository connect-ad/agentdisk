import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHead, Panel, Input, Button, Icon, Alert } from '../components/index.js';

/**
 * Support, from `AgentDisk Dashboard.dc.html`.
 *
 * ── This screen has no backend, and says so ───────────────────────────────
 * The design draws a working ticket form: pick a topic, write a description,
 * attach an audit export, "Send request" / "Save draft", and a green line
 * promising a reply within an hour for priority topics.
 *
 * There is no support endpoint in this product. Not a stub, not an unwired
 * handler — nothing in `apps/api` accepts a ticket, and no address is
 * configured anywhere in the repo to forward one to.
 *
 * So the form renders as the design draws it, and the submit is visibly
 * disabled with the reason next to it. The alternative — a button that looks
 * live and silently discards what somebody typed after an agent has been
 * failing for an hour — is the exact failure `backlog/023` tracks, and it is
 * at its worst here: the one screen people reach when something is already
 * wrong.
 *
 * The response-time promises are not rendered at all. "Priority · replies
 * within 1 hour" against a form that sends nowhere is a commitment the product
 * cannot keep.
 *
 * When an endpoint exists, wiring it is: drop `disabled`, call it from
 * `submit`, and delete this comment.
 */

const TOPICS = [
  { id: 'billing', label: 'Billing or invoices' },
  { id: 'keys', label: 'Key or scope problem' },
  { id: 'errors', label: 'Agent hitting 5xx' },
  { id: 'other', label: 'Something else' },
];

export default function Support() {
  const { ws } = useParams();
  const [topic, setTopic] = useState('errors');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  return (
    <div className="acct acct--support">
      <PageHead
        title="Support"
        subtitle="Tell us what broke and we will look at the same logs you can see."
      />

      <Alert tone="warn" title="This form cannot send yet">
        There is no support endpoint behind it. Until there is, reach us the way
        you already do — the form is here so the details you would send are the
        ones we will ask for.
      </Alert>

      <Panel title="What do you need help with?">
        <div className="sup__topics">
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

      <Panel
        title="Describe the problem"
        footer={
          <>
            <Button disabled aria-disabled="true">Send request</Button>
            <span className="ad-meta">Not available yet — no support endpoint</span>
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
    </div>
  );
}
