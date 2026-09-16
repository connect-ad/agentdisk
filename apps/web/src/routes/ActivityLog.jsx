import React, { useState, useMemo } from 'react';
import {
  PageHead, Panel, Select, Input, Button, Icon, Badge, ActivityRow,
  EmptyState, Skeleton, CodeBlock
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';

/**
 * 8.20 Activity / Audit Log — MVP-1
 * URL: /w/{ws}/activity
 *
 * Rows expand inline (never navigate) to show raw event detail for support and
 * security work. Per Principle 5 the expansion still shows no raw tenant IDs or
 * object keys — request id, IP and client string only.
 *
 * States: loading | populated | empty-filtered | empty-none
 */

const loadActivity = (api, workspaceId) => api.listActivity(workspaceId, 200);

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The resource an event was about, in the form a person recognises. Falls back
 * to the id rather than inventing a label - a row that cannot say what it
 * touched should say so, not guess.
 */
function describeResource(event) {
  const name = event.metadata?.name ?? event.metadata?.path ?? event.metadata?.email;
  return name ?? event.resource?.id ?? '—';
}

export default function ActivityLog() {
  const { status, data, error, reload } = useResource(loadActivity);
  const loading = status === 'loading';

  const [actor, setActor] = useState('all');
  const [action, setAction] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);

  const events = useMemo(
    () =>
      (data?.events ?? []).map(e => ({
        id: e.id,
        action: e.action,
        actor: e.actor?.id ?? '—',
        actorType: e.actor?.type ?? 'user',
        resource: describeResource(e),
        time: relativeTime(e.at),
        status: e.result === 'success' ? 'ok' : e.result,
        detail: e.result === 'denied' ? 'Rejected before it reached storage' : undefined,
        ip: e.ip ?? '—',
        client: e.client ?? '—',
        req: e.requestId ?? '—'
      })),
    [data]
  );

  const none = status === 'loaded' && events.length === 0;

  const rows = useMemo(() => {
    if (loading) return [];
    return events.filter(e => {
      if (actor !== 'all' && e.actorType !== actor) return false;
      if (action !== 'all' && e.action.split('.')[0] !== action) return false;
      const q = query.trim().toLowerCase();
      if (q && !(e.resource + e.actor + e.action).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, actor, action, query, loading]);

  const filtered = actor !== 'all' || action !== 'all' || query.trim().length > 0;
  const clearFilters = () => { setActor('all'); setAction('all'); setQuery(''); };

  return (
    <>
      <PageHead
        title="Activity"
        subtitle="Every action taken in this workspace, by a person or an agent."
        actions={<Button variant="secondary" icon={<Icon name="download" size={14} />}>Export CSV</Button>}
      />

      <div className="toolbar">
        <Select
          value={actor}
          onChange={e => setActor(e.target.value)}
          options={[
            { value: 'all', label: 'Actor: All' },
            { value: 'user', label: 'Actor: People' },
            { value: 'agent', label: 'Actor: Agents' }
          ]}
        />
        <Select
          value={action}
          onChange={e => setAction(e.target.value)}
          options={[
            { value: 'all', label: 'Action: All' },
            { value: 'file', label: 'Action: Files' },
            { value: 'folder', label: 'Action: Folders' },
            { value: 'key', label: 'Action: Keys' },
            { value: 'agent', label: 'Action: Agents' },
            { value: 'mcp', label: 'Action: MCP calls' },
            { value: 'auth', label: 'Action: Auth' }
          ]}
        />
        <Input
          leadingIcon={<Icon name="search" size={14} style={{ color: 'var(--ink-4)' }} />}
          placeholder="Actor, action or resource"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <span className="toolbar__spacer" />
        <Select
          defaultValue="7d"
          options={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' },
            { value: 'custom', label: 'Custom range' }
          ]}
        />
      </div>

      <Panel flush title="Events">
        {loading ? (
          <div style={{ padding: 'var(--s-6)', display: 'flex', flexDirection: 'column', gap: 'var(--s-6)' }}>
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="row" style={{ gap: 'var(--s-5)' }}>
                <Skeleton width={24} height={24} radius={4} />
                <div style={{ flex: 1 }}><Skeleton lines={2} height={9} /></div>
                <Skeleton width={52} height={9} />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={<Icon name="search" size={19} />}
              title="No events match your filters."
              actions={<Button size="sm" variant="secondary" onClick={clearFilters}>Clear filters</Button>}
            />
          ) : (
            <EmptyState icon={<Icon name="activity" size={19} />} title="No activity yet">
              Actions your team and agents take will show up here.
            </EmptyState>
          )
        ) : (
          rows.map(e => (
            <div key={e.id}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open === e.id}
                onClick={() => setOpen(open === e.id ? null : e.id)}
                onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(open === e.id ? null : e.id); } }}
                style={{ cursor: 'pointer' }}
              >
                <ActivityRow {...e} />
              </div>
              {open === e.id ? (
                <div style={{ padding: 'var(--s-5) var(--s-6)', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
                  <div className="row" style={{ gap: 'var(--s-4)', marginBottom: 'var(--s-4)' }}>
                    <Badge tone={e.status === 'denied' ? 'danger' : 'ok'} dot>
                      {e.status === 'denied' ? 'Denied' : 'Allowed'}
                    </Badge>
                    <span className="ad-mono-sm" style={{ color: 'var(--ink-3)' }}>{e.req}</span>
                  </div>
                  <dl className="dl">
                    <dt>Request ID</dt><dd className="ad-mono-sm">{e.req}</dd>
                    <dt>Source IP</dt><dd className="ad-mono-sm">{e.ip}</dd>
                    <dt>Client</dt><dd className="ad-mono-sm">{e.client}</dd>
                    <dt>Resource</dt><dd className="ad-mono-sm">{e.resource}</dd>
                  </dl>
                </div>
              ) : null}
            </div>
          ))
        )}
      </Panel>
    </>
  );
}
