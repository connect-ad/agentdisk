import React, { useState } from 'react';
import { adminApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { bytes, count, dateTime } from '../lib/format.js';
import { card, dataRow, headRow, input, mono, paneIn, pills, secondaryBtn, th } from '../lib/ui.js';

/**
 * Claim links, and what has happened to each one.
 *
 * The question support actually gets is not "is this token valid" — the
 * customer already knows it is not, which is why they wrote in. It is "who
 * else has had this link", and before this screen nothing could answer it.
 *
 * ── Why the preview stopped explaining itself ──────────────────────────────
 * A claimed link now answers exactly as a token that never existed does. That
 * route takes no credential, so a distinguishable answer told anybody guessing
 * tokens which guesses named a real workspace. The explanation moved here,
 * behind a login, which is where it should always have been.
 *
 * ── Why the list is workspaces, not attempts ───────────────────────────────
 * A link exists whether or not anybody has ever opened it, and the untouched
 * ones are exactly what somebody looks for when asked why a person never got
 * theirs. Attempts are a column, not the subject.
 *
 * ── Due for deletion ───────────────────────────────────────────────────────
 * The one filter with a deadline attached: unclaimed and past its seven days,
 * which is precisely what the next sweep destroys. It is what you look at
 * before pressing run-now on the Deletions screen.
 */
export function ClaimLinks() {
  const [state, setState] = useState('all');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [open, setOpen] = useState(null);

  const links = useResource(() => adminApi.claimLinks(state, applied), [state, applied]);

  return (
    <div>
      <h2 className="ds__h2">Claim links</h2>
      <p className="ds__sub">
        Every workspace an agent provisioned, and where its link stands. A link and the
        sandbox it names both last seven days.
      </p>

      <section style={card}>
        <div style={paneIn}>
          <div className="row" style={{ gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            {[
              ['all', 'All'],
              ['unclaimed', 'Unclaimed'],
              ['claimed', 'Claimed'],
              ['due', 'Due for deletion']
            ].map(([key, label]) => (
              <button
                key={key}
                type="button"
                style={state === key ? { ...secondaryBtn, fontWeight: 'var(--w-med)' } : secondaryBtn}
                onClick={() => setState(key)}
              >
                {label}
              </button>
            ))}

            <form
              onSubmit={event => {
                event.preventDefault();
                setApplied(query.trim());
              }}
              style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--s-3)' }}
            >
              <input
                style={{ ...input, minWidth: '260px' }}
                placeholder="Workspace ID, or a token hash from the log"
                value={query}
                onChange={event => setQuery(event.target.value)}
                aria-label="Search claim links"
              />
              <button type="submit" style={secondaryBtn}>Search</button>
            </form>
          </div>

          {links.status === 'loading' ? <Skeleton rows={4} /> : null}
          {links.status === 'error' ? <ErrorState error={links.error} onRetry={links.reload} /> : null}
          {links.status === 'loaded' && links.data.links.length === 0 ? (
            <EmptyState compact title="No links match" />
          ) : null}

          {links.status === 'loaded' && links.data.links.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={headRow}>
                  <th style={th}>Workspace</th>
                  <th style={th}>Created</th>
                  <th style={th}>Holds</th>
                  <th style={th}>State</th>
                  <th style={th}>Claimed by</th>
                  <th style={th}>Attempts</th>
                </tr>
              </thead>
              <tbody>
                {links.data.links.map(link => (
                  <tr key={link.workspaceId} style={dataRow}>
                    <td>
                      <div>{link.name}</div>
                      <div style={mono}>{link.workspaceId}</div>
                    </td>
                    <td style={mono}>{dateTime(link.createdAt)}</td>
                    <td style={mono}>
                      {count(link.fileCount)} · {bytes(link.storageBytes)}
                    </td>
                    <td>{linkState(link)}</td>
                    <td>{link.claimedByEmail ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        style={secondaryBtn}
                        onClick={() => setOpen(open === link.tokenHash ? null : link.tokenHash)}
                      >
                        {count(link.attempts)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      {open ? <History tokenHash={open} /> : null}
    </div>
  );
}

function History({ tokenHash }) {
  const attempts = useResource(() => adminApi.claimLinkHistory(tokenHash), [tokenHash]);

  return (
    <section style={{ ...card, marginTop: 'var(--s-7)' }}>
      <div style={paneIn}>
        <h3 className="ds__h3">History</h3>
        {/*
          The hash, never a token. Only the hash was ever stored - which is
          what lets somebody confirm WHICH link was used and never use it.
        */}
        <p className="ad-meta" style={mono}>{tokenHash}</p>

        {attempts.status === 'loading' ? <Skeleton rows={3} /> : null}
        {attempts.status === 'error' ? (
          <ErrorState error={attempts.error} onRetry={attempts.reload} />
        ) : null}
        {attempts.status === 'loaded' && attempts.data.attempts.length === 0 ? (
          <EmptyState compact title="Nobody has opened this link" />
        ) : null}
        {attempts.status === 'loaded' && attempts.data.attempts.length > 0 ? (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={headRow}>
                <th style={th}>When</th>
                <th style={th}>Outcome</th>
                <th style={th}>From</th>
                <th style={th}>Client</th>
              </tr>
            </thead>
            <tbody>
              {attempts.data.attempts.map(a => (
                <tr key={a.id} style={dataRow}>
                  <td style={mono}>{dateTime(a.createdAt)}</td>
                  <td>{outcomePill(a.outcome)}</td>
                  <td style={mono}>{a.ip ?? '—'}</td>
                  <td style={{ maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {a.userAgent ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </section>
  );
}

function linkState(link) {
  if (link.claimedAt !== null) return <span style={pills.ok}>claimed</span>;
  const age = Date.now() - link.createdAt;
  if (age >= 7 * 24 * 60 * 60 * 1000) return <span style={pills.danger}>due for deletion</span>;
  return <span style={pills.neutral}>unclaimed</span>;
}

function outcomePill(outcome) {
  if (outcome === 'claimed') return <span style={pills.ok}>claimed</span>;
  if (outcome === 'previewed') return <span style={pills.neutral}>previewed</span>;
  // The three the caller is no longer told apart. Support is.
  return <span style={pills.warn}>{outcome.replace(/_/g, ' ')}</span>;
}
