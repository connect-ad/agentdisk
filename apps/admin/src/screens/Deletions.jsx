import React, { useState } from 'react';
import { adminApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { ConfirmModal } from '../components/Overlay.jsx';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { bytes, count, dateTime } from '../lib/format.js';
import { card, dataRow, headRow, mono, paneIn, pills, primaryBtn, th } from '../lib/ui.js';

/**
 * What is queued for deletion, what the last runs did, and a control to run now.
 *
 * `job_runs` has been written by the sweep since deferred deletion landed and
 * read by nothing — so until this screen existed, nobody could see what was
 * waiting, what had been erased, or whether the job was running at all. A
 * sweep that stopped reporting looked exactly like a sweep with nothing to do.
 *
 * ── Two queues, counted apart ──────────────────────────────────────────────
 * Bytes and accounts are separate numbers rather than one "pending" total.
 * They answer different questions: one is storage still being paid for after a
 * customer deleted it, the other is people who cannot yet sign up again with
 * their own address. A single figure would answer neither.
 *
 * ── What "run now" does, and does not ──────────────────────────────────────
 * It honours `PENDING_DELETION_ENABLED`. A button that deleted while the
 * environment said not to would make that flag a suggestion, and the flag is
 * what stands between a misconfigured deployment and somebody's files — so a
 * run in a reporting-only environment reports, and the row says so.
 *
 * It does NOT take rows before their due date. That would break the seven-day
 * window a customer was promised, and doing it needs a conversation rather
 * than a button.
 */
export function Deletions({ onToast }) {
  const queue = useResource(() => adminApi.deletionQueue(), []);
  const runs = useResource(() => adminApi.deletionRuns(), []);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function runNow(reason) {
    setBusy(true);
    setError(null);
    try {
      const result = await adminApi.runDeletionSweep(reason);
      setConfirming(false);
      onToast?.(
        result.dryRun
          ? `Reported only — ${count(result.examined)} examined, nothing erased.`
          : `Erased ${count(result.objectsDeleted)} object(s), ${bytes(result.bytesFreed)} freed.`
      );
      queue.reload();
      runs.reload();
    } catch (err) {
      setError(err?.message ?? 'The sweep could not be run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="ds__h2">Deletions</h2>
      <p className="ds__sub">
        Files whose bytes are waiting, accounts whose identity is waiting, and what the
        sweep has done. The window is seven days from the moment a workspace or account
        was deleted.
      </p>

      <section style={card}>
        <div style={paneIn}>
          <h3 className="ds__h3">Waiting</h3>
          {queue.status === 'loading' ? <Skeleton rows={2} /> : null}
          {queue.status === 'error' ? <ErrorState error={queue.error} onRetry={queue.reload} /> : null}
          {queue.status === 'loaded' ? (
            <div style={{ display: 'flex', gap: 'var(--s-7)', flexWrap: 'wrap' }}>
              <Figure label="Files" value={count(queue.data.files)} note={bytes(queue.data.bytes)} />
              <Figure
                label="Due now"
                value={count(queue.data.overdue)}
                note="the next run takes these"
              />
              <Figure
                label="Accounts"
                value={count(queue.data.accounts)}
                note={`${count(queue.data.accountsOverdue)} due`}
              />
              <Figure
                label="Oldest entry"
                value={queue.data.oldestMarkedAt ? dateTime(queue.data.oldestMarkedAt) : '—'}
                /* Age rather than count is how a stalled queue shows itself: a
                   small number that never moves reads as "nothing to do". */
                note="a date that stops moving means the sweep has stopped"
              />
            </div>
          ) : null}

          <div style={{ marginTop: 'var(--s-6)' }}>
            <button type="button" style={primaryBtn} onClick={() => setConfirming(true)}>
              Run the sweep now
            </button>
          </div>
        </div>
      </section>

      <section style={{ ...card, marginTop: 'var(--s-7)' }}>
        <div style={paneIn}>
          <h3 className="ds__h3">Recent runs</h3>
          {runs.status === 'loading' ? <Skeleton rows={4} /> : null}
          {runs.status === 'error' ? <ErrorState error={runs.error} onRetry={runs.reload} /> : null}
          {runs.status === 'loaded' && runs.data.runs.length === 0 ? (
            <EmptyState compact title="No runs recorded yet" />
          ) : null}
          {runs.status === 'loaded' && runs.data.runs.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={headRow}>
                  <th style={th}>Started</th>
                  <th style={th}>Trigger</th>
                  <th style={th}>Examined</th>
                  <th style={th}>Erased</th>
                  <th style={th}>Freed</th>
                  <th style={th}>Result</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.runs.map(run => (
                  <tr key={run.id} style={dataRow}>
                    <td style={mono}>{dateTime(run.startedAt)}</td>
                    <td>
                      {run.trigger === 'admin' ? (
                        <span title={run.actorEmail ?? ''}>{run.actorEmail ?? 'admin'}</span>
                      ) : (
                        'cron'
                      )}
                    </td>
                    <td style={mono}>{count(run.examined)}</td>
                    <td style={mono}>{count(run.objectsDeleted)}</td>
                    <td style={mono}>{bytes(run.bytesFreed)}</td>
                    <td>{outcome(run)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      <ConfirmModal
        open={confirming}
        destructive
        title="Run the deletion sweep now?"
        description="This erases the bytes of every file already past its seven-day window, ahead of the next scheduled run. It cannot be undone, and it does not take anything before its due date."
        requireReason
        confirmLabel="Run the sweep"
        busy={busy}
        error={error}
        onCancel={() => setConfirming(false)}
        onConfirm={runNow}
      />
    </div>
  );
}

function Figure({ label, value, note }) {
  return (
    <div style={{ minWidth: '140px' }}>
      <div className="ad-meta">{label}</div>
      <div style={{ fontSize: 'var(--t-24)', fontWeight: 'var(--w-med)', color: 'var(--ink)' }}>
        {value}
      </div>
      <div className="ad-meta">{note}</div>
    </div>
  );
}

/**
 * A run that never finished is shown, not hidden.
 *
 * `finishedAt` staying null is the only signal that a sweep died half-way, and
 * a job that stopped reporting is the thing you most want to see.
 */
function outcome(run) {
  if (run.finishedAt === null) return <span style={pills.warn}>interrupted</span>;
  if (run.error) return <span style={pills.danger}>failed</span>;
  if (run.dryRun) return <span style={pills.neutral}>reported only</span>;
  if (run.failed > 0) return <span style={pills.warn}>{count(run.failed)} failed</span>;
  return <span style={pills.ok}>done</span>;
}
