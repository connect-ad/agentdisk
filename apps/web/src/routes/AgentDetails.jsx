import React, { useCallback, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  PageHead, Panel, Tabs, DataTable, Button, Icon, Badge, Switch, Alert,
  ApiKeyDisplay, ActivityRow, ConfirmModal, Modal, Input, EmptyState, Toast, StatTile
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.15 Agent Details.
 * URL: /w/{ws}/agents/{agentId}
 *
 * Everything on this screen comes from the API. It previously did not: the
 * title was the literal string 'Research assistant', four stat tiles carried
 * invented numbers, and the enable/disable switch set React state and showed a
 * toast saying "Agent disabled" without ever making a request - so the agent's
 * keys went on working while the page claimed they had stopped. A control that
 * lies about a security action is worse than one that is missing, because the
 * missing one sends you to the API.
 *
 * Tiles that had no endpoint behind them (requests/7d, files written,
 * transport) are gone rather than reworded. There is nowhere to get those
 * numbers from, so there is nothing to show.
 */

/**
 * How many workspace events to search for this agent's.
 *
 * There is no server-side actor filter on /v1/activity, so this is the whole
 * mechanism: fetch a window and filter it here. The number is stated on screen
 * rather than hidden, because an agent quiet for longer than the window shows
 * nothing, and "no recent activity" and "no activity ever" are different
 * claims.
 */
const ACTIVITY_WINDOW = 200;

/** How many of this agent's events the Overview tab previews before the tab. */
const OVERVIEW_EVENTS = 6;

/**
 * The agent, its keys and its recent events in one pass.
 *
 * The agent itself is load-bearing - without it there is no page - so its
 * failure rejects and the screen shows the failed state. The other two degrade
 * independently: a reader who cannot list keys should still see the agent. They
 * resolve to `null` on failure and `[]` when there genuinely are none, because
 * collapsing those two is how a screen tells somebody their data is gone when
 * one request simply did not arrive.
 */
const loadAgent = async (api, workspaceId, agentId) => {
  const [agent, keys, activity] = await Promise.allSettled([
    api.getAgent(workspaceId, agentId),
    api.listKeys(workspaceId),
    api.listActivity(workspaceId, ACTIVITY_WINDOW)
  ]);

  if (agent.status === 'rejected') throw agent.reason;

  return {
    agent: agent.value.agent,
    keys:
      keys.status === 'fulfilled'
        ? (keys.value.keys ?? []).filter(k => k.agentId === agentId)
        : null,
    keysError: keys.status === 'rejected' ? keys.reason : null,
    events:
      activity.status === 'fulfilled'
        ? (activity.value.events ?? []).filter(e => e.actor?.id === agentId)
        : null,
    eventsError: activity.status === 'rejected' ? activity.reason : null
  };
};

function relativeTime(iso) {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function absoluteDate(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  return new Date(then).toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

/** Matches ActivityLog: name the thing an event touched, never invent a label. */
function describeResource(event) {
  const name = event.metadata?.name ?? event.metadata?.path ?? event.metadata?.email;
  return name ?? event.resource?.id ?? '—';
}

function toRow(e) {
  return {
    id: e.id,
    action: e.action,
    actor: e.actor?.id ?? '—',
    actorType: e.actor?.type ?? 'user',
    resource: describeResource(e),
    time: relativeTime(e.at),
    status: e.result === 'success' ? 'ok' : e.result,
    detail: e.result === 'denied' ? 'Rejected before it reached storage' : undefined
  };
}

function describeError(error) {
  if (!error) return '';
  return `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}`;
}

export default function AgentDetails() {
  const { ws, agentId } = useParams();
  const navigate = useNavigate();
  const { api, workspaceId, canWrite } = useWorkspace();

  const load = useCallback((client, id) => loadAgent(client, id, agentId), [agentId]);
  const { status, data, error, reload } = useResource(load, [agentId]);

  const [tab, setTab] = useState('overview');
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const loading = status === 'loading';
  const agent = data?.agent ?? null;
  const keys = data?.keys ?? null;
  const events = data?.events ?? null;
  const enabled = agent?.status === 'active';

  const activeKeys = useMemo(() => (keys ?? []).filter(k => k.status === 'active'), [keys]);

  /**
   * Keys the API reports as blocked - intact, but refused because this agent is
   * disabled. Counted apart from active ones so the tile can say a disabled
   * agent has no live keys while still accounting for the credentials that come
   * back the moment it is re-enabled.
   */
  const blockedKeys = useMemo(() => (keys ?? []).filter(k => k.status === 'blocked'), [keys]);

  /**
   * What this agent can actually do, read off its live keys rather than stated
   * as a property of the agent - the agent has no permissions of its own, the
   * keys carry them, and two keys may differ.
   */
  const permission = useMemo(() => {
    // Blocked keys count here but not in the live tally. Disabling an agent
    // should not blank out what it is permitted to do - that is the thing you
    // want to read while deciding whether to switch it back on.
    const carrying = [...activeKeys, ...blockedKeys];
    if (carrying.length === 0) return null;
    const ops = [...new Set(carrying.flatMap(k => k.scopes?.ops ?? []))].sort();
    const prefixes = [
      ...new Set(carrying.map(k => (k.scopes?.pathPrefix ? `${k.scopes.pathPrefix}/*` : '/*')))
    ];
    return { ops, prefixes };
  }, [activeKeys, blockedKeys]);

  const eventRows = useMemo(() => (events ?? []).map(toRow), [events]);

  const setStatus = async next => {
    setBusy(true);
    setActionError(null);
    try {
      await api.updateAgent(workspaceId, agentId, { status: next });
      setToast(
        next === 'disabled'
          ? 'Agent disabled — its keys stop working on their next request'
          : 'Agent enabled'
      );
      void reload();
    } catch (err) {
      setActionError(describeError(err));
    } finally {
      setBusy(false);
      setConfirmDisable(false);
    }
  };

  /**
   * The blast radius, stated before the button rather than discovered after it.
   *
   * "Live" means a key that still authenticates, or would the moment the agent
   * were re-enabled — active plus blocked. An already-expired or already-revoked
   * key is counted out, because telling somebody they are about to revoke a
   * credential that has been dead for a month is noise dressed as a warning.
   * The API revokes those too; it just costs nobody anything.
   *
   * `null` when the key list failed to load, which is not the same as zero and
   * must not be shown as it.
   */
  const liveKeyCount = keys === null ? null : activeKeys.length + blockedKeys.length;

  const deleteAgent = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      // The count comes back from the API rather than from the tally above:
      // this is what was actually revoked, and a key minted in another tab
      // between opening this dialog and confirming it is in that number.
      const result = await api.deleteAgent(workspaceId, agentId);
      const revoked = result?.keysRevoked ?? 0;
      setConfirmDelete(false);
      navigate(`/w/${ws}/agents`, {
        replace: true,
        state: {
          deleted: agent?.name ?? 'Agent',
          keysRevoked: revoked
        }
      });
    } catch (err) {
      setDeleteError(describeError(err));
    } finally {
      setDeleting(false);
    }
  };

  const keyColumns = [
    { key: 'name', header: 'Name', primary: true },
    { key: 'key', header: 'Key', width: 190, render: r => <ApiKeyDisplay lastFour={r.lastFour} /> },
    {
      key: 'scope',
      header: 'Scope',
      width: 250,
      render: r => (
        <Badge mono>
          {`${(r.scopes?.ops ?? []).join(', ') || '—'} · ${r.scopes?.pathPrefix ? `${r.scopes.pathPrefix}/*` : '/*'}`}
        </Badge>
      )
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      width: 130,
      render: r => <span style={{ color: 'var(--ink-3)' }}>{relativeTime(r.lastUsedAt)}</span>
    },
    {
      key: 'expires',
      header: 'Expires',
      width: 130,
      render: r => (
        <span style={{ color: 'var(--ink-3)' }}>
          {r.expiresAt ? absoluteDate(r.expiresAt) : 'Never'}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
      render: r =>
        r.status === 'revoked' ? <Badge tone="danger" dot>Revoked</Badge>
          : r.status === 'expired' ? <Badge tone="warn" dot>Expired</Badge>
            : r.status === 'blocked' ? <Badge tone="warn" dot>Blocked</Badge>
              : <Badge tone="ok" dot>Active</Badge>
    }
  ];

  return (
    <>
      <PageHead
        title={agent?.name ?? (loading ? 'Loading agent…' : 'Agent')}
        subtitle={agentId}
        meta={
          agent
            ? enabled
              ? <Badge tone="ok" dot pulse>Active</Badge>
              : <Badge tone="danger" dot>Disabled</Badge>
            : null
        }
        actions={
          <>
            {agent && canWrite ? (
              <Switch
                label={enabled ? 'Enabled' : 'Disabled'}
                checked={enabled}
                disabled={busy}
                onChange={() => (enabled ? setConfirmDisable(true) : setStatus('active'))}
              />
            ) : null}
            <Button variant="secondary" onClick={() => navigate(`/w/${ws}/agents`)}>
              Back to agents
            </Button>
          </>
        }
      />

      {status === 'failed' ? (
        <Alert
          tone="danger"
          title="Could not load this agent"
          actions={<Button size="sm" onClick={reload}>Try again</Button>}
        >
          {describeError(error)}
        </Alert>
      ) : null}

      {actionError ? (
        <Alert tone="danger" title="Could not change the agent's status">{actionError}</Alert>
      ) : null}

      {agent && !enabled ? (
        <Alert tone="danger" title="This agent is disabled">
          Its API keys will not authenticate. Re-enable it to restore access.
        </Alert>
      ) : null}

      {agent ? (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'overview', label: 'Overview' },
              { value: 'keys', label: 'Keys', count: keys?.length ?? undefined },
              { value: 'activity', label: 'Activity' }
            ]}
          />

          {tab === 'overview' ? (
            <>
              <div className="grid-stats">
                <StatTile
                  label="Status"
                  icon={<Icon name="shield" size={13} />}
                  value={enabled ? 'Active' : 'Disabled'}
                  sub={enabled ? 'Its keys authenticate' : 'Its keys are refused'}
                />
                <StatTile
                  label="Live keys"
                  icon={<Icon name="key" size={13} />}
                  value={keys === null ? '—' : activeKeys.length}
                  sub={
                    keys === null
                      ? 'Key list unavailable'
                      : blockedKeys.length > 0
                        ? `${blockedKeys.length} blocked while this agent is disabled`
                        : `${keys.length} issued in total`
                  }
                />
                <StatTile
                  label="Last seen"
                  icon={<Icon name="bolt" size={13} />}
                  value={relativeTime(agent.lastSeenAt)}
                  sub={agent.lastSeenAt ? absoluteDate(agent.lastSeenAt) : 'Has never authenticated'}
                />
                <StatTile
                  label="Permission"
                  icon={<Icon name="lock" size={13} />}
                  value={permission ? permission.ops.join(', ') : '—'}
                  sub={
                    permission
                      ? permission.prefixes.join(' · ')
                      : 'No live key carries a scope'
                  }
                />
              </div>

              <Panel title="Details">
                <dl className="dl">
                  <dt>Description</dt>
                  <dd>{agent.description || 'None'}</dd>
                  <dt>Agent ID</dt>
                  <dd className="ad-mono-sm">{agent.id}</dd>
                  <dt>Created</dt>
                  <dd>{absoluteDate(agent.createdAt)}</dd>
                  <dt>Created by</dt>
                  <dd className="ad-mono-sm">{agent.createdBy}</dd>
                </dl>
              </Panel>

              <Panel
                flush
                title="Recent activity"
                subtitle={`This agent's events within the workspace's last ${ACTIVITY_WINDOW}.`}
                actions={
                  eventRows.length > OVERVIEW_EVENTS ? (
                    <Button size="sm" variant="secondary" onClick={() => setTab('activity')}>
                      See all {eventRows.length}
                    </Button>
                  ) : null
                }
              >
                {events === null ? (
                  <Alert tone="danger" title="Could not load activity">
                    {describeError(data?.eventsError)}
                  </Alert>
                ) : eventRows.length === 0 ? (
                  <EmptyState
                    compact
                    icon={<Icon name="activity" size={19} />}
                    title="Nothing from this agent recently"
                  >
                    It has done nothing in the workspace&apos;s last {ACTIVITY_WINDOW} events.
                  </EmptyState>
                ) : (
                  eventRows.slice(0, OVERVIEW_EVENTS).map(e => <ActivityRow key={e.id} {...e} />)
                )}
              </Panel>

              {/*
                Same shape as Settings → General's danger zone, deliberately: a
                destructive action people meet twice should not be two different
                interactions. Hidden from a reader, who the API refuses anyway —
                `delete` is not in a reader's scope.
              */}
              {canWrite ? (
                <section aria-label="Danger zone">
                  <Panel title="Danger zone" className="danger-zone">
                    <Alert tone="danger" title="Delete this agent">
                      This permanently deletes <strong>{agent.name}</strong> and revokes every
                      key it holds. Revoking is not reversible — anything still using one of
                      those keys needs a new key against a different agent.
                    </Alert>
                    <div>
                      <Button
                        variant="danger"
                        onClick={() => {
                          setConfirmText('');
                          setDeleteError(null);
                          setConfirmDelete(true);
                        }}
                      >
                        Delete agent
                      </Button>
                    </div>
                  </Panel>
                </section>
              ) : null}
            </>
          ) : null}

          {tab === 'keys' ? (
            <Panel
              flush
              title="API keys"
              subtitle="Keys minted against this agent. Disabling the agent stops all of them."
              actions={
                canWrite ? (
                  <Button size="sm" onClick={() => navigate(`/w/${ws}/keys`)}>Create key</Button>
                ) : null
              }
            >
              {keys === null ? (
                <Alert tone="danger" title="Could not load keys">
                  {describeError(data?.keysError)}
                </Alert>
              ) : (
                <DataTable
                  columns={keyColumns}
                  rows={keys}
                  rowKey="id"
                  empty={
                    <EmptyState
                      icon={<Icon name="key" size={19} />}
                      title="This agent holds no keys"
                      actions={
                        canWrite ? (
                          <Button size="sm" onClick={() => navigate(`/w/${ws}/keys`)}>
                            Create key
                          </Button>
                        ) : null
                      }
                    >
                      An agent with no credential cannot authenticate, so it will never
                      appear in the activity log.
                    </EmptyState>
                  }
                />
              )}
            </Panel>
          ) : null}

          {tab === 'activity' ? (
            <Panel
              flush
              title="Activity"
              subtitle={`Filtered from the workspace's last ${ACTIVITY_WINDOW} events — there is no per-agent history endpoint yet.`}
              actions={
                <Button size="sm" variant="secondary" onClick={() => navigate(`/w/${ws}/activity`)}>
                  Open workspace activity
                </Button>
              }
            >
              {events === null ? (
                <Alert tone="danger" title="Could not load activity">
                  {describeError(data?.eventsError)}
                </Alert>
              ) : eventRows.length === 0 ? (
                <EmptyState
                  compact
                  icon={<Icon name="activity" size={19} />}
                  title="Nothing from this agent recently"
                >
                  It has done nothing in the workspace&apos;s last {ACTIVITY_WINDOW} events.
                  Older activity is still in the workspace log.
                </EmptyState>
              ) : (
                eventRows.map(e => <ActivityRow key={e.id} {...e} />)
              )}
            </Panel>
          ) : null}
        </>
      ) : null}

      <ConfirmModal
        open={confirmDisable}
        title={`Disable ${agent?.name ?? 'this agent'}?`}
        description="All of its API keys stop authenticating on their next request. Nothing is deleted, and you can re-enable it at any time."
        confirmLabel="Disable agent"
        loading={busy}
        onClose={() => setConfirmDisable(false)}
        onConfirm={() => setStatus('disabled')}
      />

      <Modal
        open={confirmDelete}
        title={`Delete ${agent?.name ?? 'this agent'}?`}
        tone="danger"
        mark={<Icon name="alert" size={16} />}
        onClose={() => setConfirmDelete(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={deleting}
              /* Typing the name is the confirmation, and the API checks it for
                 the workspace delete for the same reason it is asked here: a
                 destructive action should be impossible to reach by muscle
                 memory. */
              disabled={confirmText !== (agent?.name ?? '')}
              onClick={deleteAgent}
            >
              Delete agent
            </Button>
          </>
        }
      >
        <Alert tone="danger" title="This cannot be undone">
          {liveKeyCount === null ? (
            <>
              This will permanently delete <strong>{agent?.name}</strong> and revoke every key
              it holds. The key list could not be loaded, so the number is not shown here —
              the confirmation afterwards reports what was actually revoked.
            </>
          ) : (
            <>
              This will permanently delete <strong>{agent?.name}</strong> and revoke its{' '}
              {liveKeyCount} live {liveKeyCount === 1 ? 'key' : 'keys'}. Revoked keys cannot be
              reactivated.
            </>
          )}
        </Alert>
        {liveKeyCount === 0 ? (
          <Alert tone="warn" title="This agent holds no live keys">
            Nothing is using it right now, so deleting it takes no access away from anything.
          </Alert>
        ) : null}
        {deleteError ? <Alert tone="danger" title={deleteError} /> : null}
        <Input
          label="Confirm"
          mono
          placeholder={`Type ${agent?.name ?? 'the agent name'} to confirm`}
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
        />
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}
