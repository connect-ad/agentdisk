import React from 'react';
import { PageHead, Panel, Meter, Button, Icon, Badge, Alert, EmptyState } from '../components/index.js';
import { useResource } from '../lib/useResource.js';

/**
 * 8.19 Usage — MVP-0 (numbers) / MVP-1 (time-series charts).
 * URL: /w/{ws}/usage
 *
 * Every number here is real, read from `GET /v1/whoami`, which returns the
 * workspace's counters alongside the limits of its plan. Nothing on this screen
 * is computed in the browser — the API is the thing that will actually refuse a
 * request at the limit, so it has to be the thing that says where the limit is.
 * A dashboard that disagreed with it would be worse than one that showed
 * nothing.
 */

const loadUsage = (api, workspaceId) => api.whoami(workspaceId);

/** Bytes to something a person reads, at the precision the size deserves. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

const formatCount = n => (Number.isFinite(n) ? n.toLocaleString() : '—');

function daysUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86400000));
}

export default function Usage() {
  const { status, data, error, reload } = useResource(loadUsage);

  if (status === 'loading') {
    return (
      <>
        <PageHead title="Usage" />
        <Panel><p className="ad-meta" aria-live="polite">Loading usage…</p></Panel>
      </>
    );
  }

  if (status === 'failed') {
    return (
      <>
        <PageHead title="Usage" />
        <Alert
          tone="danger"
          title="Could not load your usage"
          actions={<Button size="sm" onClick={reload}>Try again</Button>}
        >
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      </>
    );
  }

  const plan = data?.workspace?.plan ?? 'free';
  const usage = data?.usage ?? {};
  const resetDays = daysUntil(usage.periodResetAt);

  const metrics = [
    { key: 'Storage', used: usage.storageBytes?.used, limit: usage.storageBytes?.max, fmt: formatBytes },
    { key: 'Files', used: usage.files?.used, limit: usage.files?.max, fmt: formatCount },
    { key: 'Egress this period', used: usage.egressBytes?.used, limit: usage.egressBytes?.max, fmt: formatBytes },
    { key: 'Requests this period', used: usage.requests?.used, limit: usage.requests?.max, fmt: formatCount }
  ].filter(m => Number.isFinite(m.limit) && m.limit > 0);

  const atLimit = metrics.filter(m => (m.used ?? 0) >= m.limit);

  return (
    <>
      <PageHead
        title="Usage"
        subtitle={resetDays === null ? undefined : `Resets in ${resetDays} day${resetDays === 1 ? '' : 's'}.`}
        meta={<Badge tone="accent">{plan}</Badge>}
      />

      {atLimit.length > 0 ? (
        <Alert tone="danger" title={`You've reached your ${atLimit[0].key.toLowerCase()} limit on the ${plan} plan.`}>
          Further requests against this metric are refused until the period resets.
        </Alert>
      ) : null}

      <Panel
        title="Plan"
        subtitle={resetDays === null ? plan : `${plan} — resets in ${resetDays} day${resetDays === 1 ? '' : 's'}`}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-7)' }}>
          {metrics.map(m => {
            const used = m.used ?? 0;
            const pct = Math.min(100, Math.round((used / m.limit) * 100));
            return (
              <div key={m.key} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
                <div className="row" style={{ gap: 'var(--s-4)' }}>
                  <span style={{ fontSize: 'var(--t-13)', fontWeight: 'var(--w-med)', color: 'var(--ink)', flex: 1 }}>
                    {m.key} — {m.fmt(used)} of {m.fmt(m.limit)}
                  </span>
                  {/* Text equivalent alongside the bar — never bar-only (spec: Accessibility). */}
                  <span
                    className="ad-mono-sm"
                    style={{ color: pct >= 95 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--ink-3)' }}
                  >
                    {pct}%
                  </span>
                </div>
                <Meter value={used} max={m.limit} label={`${m.key}: ${pct}% used`} />
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="History">
        <EmptyState compact icon={<Icon name="chart" size={19} />} title="Daily usage charts are not built yet">
          A 30-day time series per metric, at daily granularity.
        </EmptyState>
      </Panel>
    </>
  );
}
