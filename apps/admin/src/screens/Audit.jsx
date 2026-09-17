import React, { useState } from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { dateTime } from '../lib/format.js';
import {
  card,
  dataRow,
  ellipsis,
  headRow,
  input,
  label,
  mono,
  paneIn,
  pills,
  secondaryBtn,
  th
} from '../lib/ui.js';

/**
 * The staff audit log.
 *
 * This is `staff_actions` — one class of actor across every workspace and
 * outside any. It is NOT a workspace's own activity tab, which shows every
 * actor inside one workspace and is the customer's log that staff can also
 * read. The two are labelled distinctly on purpose: somebody reading a
 * customer's activity and believing it is the staff trail would draw exactly
 * the wrong conclusion about who did what.
 *
 * ── Corrections from the design ────────────────────────────────────────────
 * "RETAINED 24 MONTHS · IMMUTABLE" is invented. The truthful statement is
 * below: append-only, with no retention job, kept for the life of the record
 * set. And paging is cursor-based, not "showing 1–8 of 412", because that is
 * what the API does.
 *
 * ── Rows expand ────────────────────────────────────────────────────────────
 * The columns cannot carry a reason and a metadata blob. Expanding a row is
 * how the thing an investigation actually needs becomes reachable.
 */

const COLS = '150px minmax(0,150px) minmax(0,1fr) minmax(0,1.1fr) 110px 76px';

export function Audit({ onToast }) {
  const [filter, setFilter] = useState({ actorId: '', action: '', from: '', to: '' });
  const [applied, setApplied] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [exporting, setExporting] = useState(false);

  const options = useResource(() => staffApi.auditFilters(), []);
  const resource = useResource(() => staffApi.audit({ ...applied, limit: 100 }), [applied]);

  const rows = resource.data?.rows ?? [];

  function apply(event) {
    event.preventDefault();
    setApplied({
      actorId: filter.actorId || undefined,
      action: filter.action || undefined,
      from: filter.from ? Date.parse(filter.from) : undefined,
      to: filter.to ? Date.parse(filter.to) + 86_400_000 - 1 : undefined
    });
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const csv = await staffApi.auditExport({ ...applied, limit: undefined });
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `staff-audit-${Date.now()}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      // The export itself wrote an audit row. Saying so is how somebody learns
      // that a bulk pull of this log is itself accountable.
      onToast?.('Exported. That export is recorded in this log.');
      await resource.refresh();
    } catch (err) {
      onToast?.(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div style={paneIn}>
      <form onSubmit={apply} style={{ ...card, padding: '13px 14px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '160px' }}>
            <label htmlFor="audit-actor" style={label}>
              Staff member
            </label>
            <select
              id="audit-actor"
              value={filter.actorId}
              onChange={event => setFilter({ ...filter, actorId: event.target.value })}
              style={{ ...input, height: '34px' }}
            >
              <option value="">All staff</option>
              {(options.data?.actors ?? []).map(actor => (
                <option key={actor.actorId} value={actor.actorId}>
                  {actor.actorEmail}
                </option>
              ))}
            </select>
          </div>

          <div style={{ flex: 1, minWidth: '160px' }}>
            <label htmlFor="audit-action" style={label}>
              Action
            </label>
            <select
              id="audit-action"
              value={filter.action}
              onChange={event => setFilter({ ...filter, action: event.target.value })}
              style={{ ...input, height: '34px' }}
            >
              <option value="">All actions</option>
              {/* The prefix options are what Sync History and the per-area
                  views are built from; the index leads on action for them. */}
              <option value="plan.">plan.* (all plan changes)</option>
              <option value="user.">user.* (all account actions)</option>
              <option value="workspace.">workspace.* (all workspace actions)</option>
              <option value="staff.">staff.* (all staff account actions)</option>
              {(options.data?.actions ?? []).map(action => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
          </div>

          <div style={{ minWidth: '140px' }}>
            <label htmlFor="audit-from" style={label}>
              From
            </label>
            <input
              id="audit-from"
              type="date"
              value={filter.from}
              onChange={event => setFilter({ ...filter, from: event.target.value })}
              style={{ ...input, height: '34px' }}
            />
          </div>

          <div style={{ minWidth: '140px' }}>
            <label htmlFor="audit-to" style={label}>
              To
            </label>
            <input
              id="audit-to"
              type="date"
              value={filter.to}
              onChange={event => setFilter({ ...filter, to: event.target.value })}
              style={{ ...input, height: '34px' }}
            />
          </div>

          <button type="submit" style={secondaryBtn}>
            Apply
          </button>
          <button
            type="button"
            style={secondaryBtn}
            onClick={() => {
              setFilter({ actorId: '', action: '', from: '', to: '' });
              setApplied({});
            }}
          >
            Clear
          </button>
          <button type="button" style={secondaryBtn} onClick={exportCsv} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </form>

      {resource.error && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={resource.error} onRetry={resource.refresh} />
        </div>
      )}

      {resource.loading ? (
        <Skeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No staff actions match"
          detail="Every staff read and write lands here, including refused ones. An empty result with no filters means nothing has been done from this console yet."
        />
      ) : (
        <div style={card}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: '900px' }}>
              <div style={headRow(COLS)}>
                <span style={th}>Timestamp (UTC)</span>
                <span style={th}>Staff</span>
                <span style={th}>Action</span>
                <span style={th}>Target</span>
                <span style={th}>Source IP</span>
                <span style={th}>Result</span>
              </div>
              {rows.map(row => (
                <div key={row.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === row.id ? null : row.id)}
                    style={dataRow(COLS, true)}
                    aria-expanded={expanded === row.id}
                  >
                    <span style={{ ...mono, fontSize: '11px', color: 'var(--tx2)' }}>
                      {dateTime(row.createdAt)}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--tx)', ...ellipsis }}>
                      {row.actorEmail}
                    </span>
                    <span style={{ ...mono, fontSize: '11px', color: 'var(--acc)', ...ellipsis }}>
                      {row.action}
                    </span>
                    <span style={{ ...mono, fontSize: '11px', color: 'var(--tx2)', ...ellipsis }}>
                      {row.targetId ?? row.workspaceId ?? '—'}
                    </span>
                    <span style={{ ...mono, fontSize: '11px', color: 'var(--tx3)' }}>
                      {row.sourceIp ?? '—'}
                    </span>
                    <span style={row.result === 'success' ? pills.ok : pills.danger}>
                      {row.result}
                    </span>
                  </button>

                  {expanded === row.id && (
                    <div
                      style={{
                        padding: '12px 15px',
                        background: 'var(--surf2)',
                        borderBottom: '1px solid var(--bd)'
                      }}
                    >
                      <div style={{ fontSize: '12.5px', color: 'var(--tx)', marginBottom: '8px' }}>
                        <strong>Reason:</strong> {row.reason ?? 'none given'}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--tx2)', marginBottom: '8px' }}>
                        Role at the time: {row.actorRole} · request {row.requestId ?? '—'}
                        {row.targetType ? ` · ${row.targetType}` : ''}
                      </div>
                      <pre
                        style={{
                          ...mono,
                          margin: 0,
                          padding: '10px',
                          background: 'var(--code)',
                          color: 'var(--codeTx)',
                          borderRadius: '8px',
                          fontSize: '11px',
                          overflowX: 'auto'
                        }}
                      >
                        {row.metadata ?? '{}'}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div style={{ padding: '10px 14px', background: 'var(--surf2)' }}>
            <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)' }}>
              {rows.length} ENTRIES SHOWN · APPEND-ONLY · NO RETENTION JOB
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
