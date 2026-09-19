import React from 'react';
import { staffApi } from '../api.js';
import { useResource } from '../lib/useResource.js';
import { EmptyState, ErrorState, Skeleton } from '../components/States.jsx';
import { bytes, count, since } from '../lib/format.js';
import { card, dataRow, ellipsis, mono, paneIn, pills } from '../lib/ui.js';

/**
 * The fleet overview.
 *
 * Corrections from the design file, all of them the same correction: it renders
 * what the backend can actually supply.
 *
 * **No regions.** "412 workspaces across two regions" is fiction — this runs on
 * Workers, R2 and D1, there is no region column and no per-workspace region.
 *
 * **No MRR tile.** Billing is org-scoped and lives on the Billing screen. An
 * MRR figure here would have to be computed from a different unit than the
 * workspace count beside it.
 *
 * The attention rule is the server's, in one place, and it deliberately drops
 * the design's third criterion: nothing records webhook delivery attempts, so
 * "three or more failing webhooks" could only ever be guessed at.
 */

const TILE_ORDER = [
  { key: 'workspaces', label: 'WORKSPACES', unit: 'total' },
  { key: 'users', label: 'ACCOUNTS', unit: 'total' },
  { key: 'agents', label: 'AGENT IDENTITIES', unit: 'active' },
  { key: 'activeKeys', label: 'API KEYS', unit: 'live' },
  { key: 'storageBytes', label: 'STORAGE', unit: '', format: bytes },
  { key: 'billingProblems', label: 'BILLING PROBLEMS', unit: 'orgs', tone: 'warn' }
];

function Tile({ label, value, unit, tone }) {
  return (
    <div
      style={{
        border: `1px solid ${tone === 'warn' ? 'var(--warnBd)' : 'var(--bd)'}`,
        background: tone === 'warn' ? 'var(--warnSoft)' : 'var(--surf)',
        borderRadius: '11px',
        padding: '14px'
      }}
    >
      <div
        style={{
          ...mono,
          fontSize: '9px',
          letterSpacing: '0.11em',
          color: tone === 'warn' ? 'var(--warnTx)' : 'var(--tx3)',
          marginBottom: '9px'
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '5px' }}>
        <span
          style={{
            fontFamily: 'var(--fontHead)',
            fontSize: '27px',
            fontWeight: 600,
            letterSpacing: '-0.03em',
            color: tone === 'warn' ? 'var(--warnTx)' : 'var(--tx)',
            lineHeight: 1
          }}
        >
          {value}
        </span>
        {unit && <span style={{ fontSize: '11.5px', color: 'var(--tx2)' }}>{unit}</span>}
      </div>
    </div>
  );
}

const ATTENTION_COLS = '150px minmax(0,1fr) 120px 80px';

export function Overview({ onNavigate, onData }) {
  const summary = useResource(async () => {
    const [overview, attention] = await Promise.all([
      staffApi.overview(),
      staffApi.needsAttention()
    ]);
    // GET /v1/staff/overview answers { summary: { ... } }.
    onData?.({ attention: attention.workspaces.length, workspaces: overview.summary?.workspaces });
    return { summary: overview.summary ?? {}, attention: attention.workspaces };
  }, []);

  if (summary.loading) return <Skeleton rows={4} />;
  if (summary.error && !summary.data) {
    return <ErrorState error={summary.error} onRetry={summary.refresh} />;
  }

  const stats = summary.data?.summary ?? {};
  const attention = summary.data?.attention ?? [];

  return (
    <div style={paneIn}>
      {summary.error && (
        <div style={{ marginBottom: '14px' }}>
          <ErrorState error={summary.error} onRetry={summary.refresh} />
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: '12px'
        }}
      >
        {TILE_ORDER.map(tile => (
          <Tile
            key={tile.key}
            label={tile.label}
            unit={tile.unit}
            tone={tile.tone && stats[tile.key] > 0 ? tile.tone : undefined}
            value={(tile.format ?? count)(stats[tile.key] ?? 0)}
          />
        ))}
      </div>

      <div style={{ ...card, marginTop: '14px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '13px 15px',
            borderBottom: '1px solid var(--bd)',
            background: 'var(--surf2)',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
            <span
              style={{ width: '7px', height: '7px', borderRadius: '2px', background: 'var(--warn)' }}
            />
            <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--tx)' }}>
              Needs attention
            </span>
            <span style={{ ...mono, fontSize: '10px', color: 'var(--tx3)' }}>
              {attention.length} WORKSPACES
            </span>
          </div>
          {attention.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('/workspaces/needs-attention')}
              style={{
                background: 'transparent',
                border: 'none',
                padding: 0,
                fontFamily: 'var(--font)',
                fontSize: '12.5px',
                fontWeight: 600,
                color: 'var(--acc)',
                cursor: 'pointer'
              }}
            >
              Open filtered view
            </button>
          )}
        </div>

        {attention.length === 0 ? (
          <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: '12.5px', color: 'var(--tx2)' }}>
            Nothing is over 95% of a quota and no organization is past due.
          </div>
        ) : (
          attention.slice(0, 5).map(workspace => (
            <button
              key={workspace.id}
              type="button"
              onClick={() => onNavigate(`/workspaces/${workspace.id}`)}
              style={dataRow(ATTENTION_COLS, true)}
            >
              <span style={{ fontSize: '12.5px', fontWeight: 500, color: 'var(--tx)', ...ellipsis }}>
                {workspace.name}
              </span>
              <span style={{ fontSize: '12.5px', color: 'var(--tx2)', ...ellipsis }}>
                {workspace.why}
              </span>
              <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)', ...ellipsis }}>
                {workspace.id}
              </span>
              <span style={{ ...mono, fontSize: '10.5px', color: 'var(--tx3)', textAlign: 'right' }}>
                {since(workspace.createdAt)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export { EmptyState };
