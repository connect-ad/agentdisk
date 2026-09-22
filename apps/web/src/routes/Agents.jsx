import React, { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  PageHead, Panel, DataTable, Button, IconButton, Icon, Input, Badge,
  Modal, ConfirmModal, EmptyState, Alert, Toast
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.13 Agent Management (list) — MVP-0, plus 8.14 Create Agent (modal).
 * URL: /w/{ws}/agents
 * States: loading | populated | empty
 */

// Status badge always pairs a tone with a word — never colour alone (spec: Accessibility).
const STATUS = {
  active: { tone: 'ok', label: 'Active' },
  no_key: { tone: 'warn', label: 'No credential' },
  disabled: { tone: 'danger', label: 'Disabled' }
};

/**
 * Agents and their keys together, because "how many live keys does this agent
 * hold" is the question that decides whether deleting it is safe — and asking
 * it per row would be one request per agent.
 */
const loadAgents = async (api, workspaceId) => {
  const [agents, keys] = await Promise.all([
    api.listAgents(workspaceId),
    api.listKeys(workspaceId).catch(() => ({ keys: [] }))
  ]);
  return { agents: agents.agents ?? [], keys: keys.keys ?? [] };
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

export default function Agents() {
  const { ws } = useParams();
  const navigate = useNavigate();
  const { api, workspaceId, canWrite } = useWorkspace();
  const { status, data, error, reload } = useResource(loadAgents);

  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState(null); // 'create' | 'delete'
  const [target, setTarget] = useState(null);
  const [created, setCreated] = useState(null);

  /**
   * The agent detail page deletes and then navigates here, because the screen
   * that did the deleting no longer has anything to show. The outcome travels
   * in the navigation state so the person lands on a confirmation rather than
   * on a list that is silently one row shorter — and the key count is the one
   * the API reported, not the one the dialog estimated.
   */
  const { state: navState } = useLocation();
  const deleted = navState?.deleted ?? null;
  const deletedKeys = navState?.keysDeleted ?? 0;
  const [toast, setToast] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const loading = status === 'loading';

  const rows = (data?.agents ?? [])
    .map(a => {
      // `blocked` counts as a credential this agent holds. The API reports it
      // for a key whose agent is disabled, and excluding it would empty the
      // Keys column for exactly the agents whose keys you are trying to account
      // for - the row already says Disabled, so the count should still say how
      // many come back when it is switched on. Revoked and expired do not.
      const live = (data?.keys ?? []).filter(
        k => k.agentId === a.id && (k.status === 'active' || k.status === 'blocked')
      );
      return {
        ...a,
        keys: live.length,
        // An agent with no credential cannot authenticate, which is worth
        // saying on the row rather than leaving somebody to wonder why it
        // never appears in the activity log.
        badge: a.status !== 'active' ? 'disabled' : live.length === 0 ? 'no_key' : 'active',
        lastActive: relativeTime(a.lastSeenAt)
      };
    })
    .filter(a => a.name.toLowerCase().includes(query.trim().toLowerCase()));

  const create = async () => {
    if (!name.trim()) { setFormError('An agent needs a name.'); return; }
    if (name.trim().length > 15) { setFormError('Use at most 15 characters for the name.'); return; }
    setBusy(true); setFormError(null);
    try {
      const { agent } = await api.createAgent(workspaceId, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {})
      });
      setCreated(agent.name);
      setDialog(null);
      setName(''); setDescription('');
      void reload();
    } catch (err) {
      setFormError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await api.deleteAgent(workspaceId, target.id);
      setToast(
        result.keysDeleted > 0
          ? `Agent deleted, ${result.keysDeleted} key(s) deleted`
          : 'Agent deleted'
      );
      void reload();
    } catch (err) {
      setToast(`Could not delete: ${err.message}`);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Agent',
      primary: true,
      render: r => (
        <span className="row" style={{ gap: 'var(--s-4)' }}>
          <Icon name="agent" size={15} style={{ color: 'var(--ink-3)' }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 'var(--w-med)', color: 'var(--ink)' }}>{r.name}</span>
            <span className="ad-mono-sm" style={{ color: 'var(--ink-3)' }}>{r.id}</span>
          </span>
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      width: 190,
      render: r => <Badge tone={STATUS[r.badge].tone} dot pulse={r.badge === 'active'}>{STATUS[r.badge].label}</Badge>
    },
    { key: 'keys', header: 'Keys', align: 'right', width: 80, mono: true },
    { key: 'lastActive', header: 'Last active', width: 160, render: r => <span style={{ color: 'var(--ink-3)' }}>{r.lastActive}</span> },
    {
      key: 'act',
      header: '',
      width: 44,
      render: r => (
        <span onClick={e => e.stopPropagation()}>
          <IconButton
            icon={<Icon name="more" size={14} />}
            label={`Actions for ${r.name}`}
            onClick={() => { setTarget(r); setDialog('delete'); }}
          />
        </span>
      )
    }
  ];

  return (
    <>
      <PageHead
        title="Agents"
        subtitle="The identities your AI systems use to reach this workspace."
        actions={canWrite ? <Button icon={<Icon name="plus" size={14} />} onClick={() => { setFormError(null); setDialog('create'); }}>Create agent</Button> : null}
      />

      {deleted ? (
        <Alert tone="ok" title={`${deleted} deleted.`}>
          {deletedKeys === 0
            ? 'It held no keys, so nothing lost access.'
            : `${deletedKeys} ${deletedKeys === 1 ? 'key was' : 'keys were'} deleted with it. Anything still using one lost access immediately, and a deleted key cannot be brought back.`}
        </Alert>
      ) : null}

      {created ? (
        <Alert
          tone="accent"
          title={`${created} created. Give it an API key to let it connect.`}
          actions={<Button size="sm" onClick={() => navigate(`/w/${ws}/keys`)}>Create API key</Button>}
        >
          An agent with zero keys is inert — it cannot authenticate until you issue one.
        </Alert>
      ) : null}

      {status === 'failed' ? (
        <Alert tone="danger" title="Could not load agents" actions={<Button size="sm" onClick={reload}>Try again</Button>}>
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      ) : null}

      {!loading && rows.length > 0 ? (
        <div className="toolbar">
          <Input
            leadingIcon={<Icon name="search" size={14} style={{ color: 'var(--ink-4)' }} />}
            placeholder="Search agents"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      {/*
        The design lays agents out as cards rather than table rows: a status
        dot, the name, a badge, the mono id, then keys / requests / last seen
        along the bottom. Every figure here was already computed for the table
        it replaces — nothing new is fetched and nothing is invented. Requests
        per agent has no endpoint (one call per agent, as the note at the top of
        this file explains), so that column shows the key count and the last
        seen time, which are real.
      */}
      {loading ? (
        <Panel flush title="Agents">
          <DataTable columns={columns} rows={[]} loading skeletonRows={4} />
        </Panel>
      ) : rows.length === 0 ? (
        <Panel flush title="Agents">
          <EmptyState
            icon={<Icon name="agent" size={19} />}
            title="No agents yet"
            actions={canWrite ? <Button size="sm" onClick={() => { setFormError(null); setDialog('create'); }}>Create an agent</Button> : null}
          >
            Agents are the identities your AI systems use to access storage.
          </EmptyState>
        </Panel>
      ) : (
        <div className="ds__cards">
          {rows.map(a => (
            <Link
              key={a.id}
              to={`/w/${ws}/agents/${a.id}`}
              className="ds__acard"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <div className="ds__ahead">
                <span className={a.badge === 'active' ? 'ds__adot ds__adot--ok' : 'ds__adot ds__adot--off'} />
                <span className="ds__aname">{a.name}</span>
                <Badge tone={a.badge === 'active' ? 'ok' : a.badge === 'no_key' ? 'warn' : undefined}>
                  {a.badge === 'active' ? 'Active' : a.badge === 'no_key' ? 'No key' : 'Disabled'}
                </Badge>
              </div>
              <div className="ds__aid">{a.id}</div>
              <div className="ds__afoot">
                <span>
                  <span className="ds__afig">{a.keys}</span>
                  <span className="ds__akey">KEYS</span>
                </span>
                <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
                  <span style={{ fontSize: 'var(--t-12)', color: 'var(--ink-2)' }}>{a.lastActive}</span>
                  <span className="ds__akey">LAST SEEN</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* --- 8.14 Create agent --- */}
      <Modal
        open={dialog === 'create'}
        title="Create an agent"
        tone="accent"
        mark={<Icon name="agent" size={16} />}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={create} loading={busy}>Create agent</Button>
          </>
        }
      >
        {formError ? <div role="alert"><Alert tone="danger" title={formError} /></div> : null}
        <Input
          label="Name"
          required
          placeholder="e.g. research-bot"
          maxLength={15}
          hint="Up to 15 characters: letters, numbers, dots, dashes and underscores. Shown next to everything this agent does."
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <Input
          label="Description"
          optional
          multiline
          placeholder="What this agent is for, and which files it should touch."
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
      </Modal>

      {/* --- delete: blocked when the agent still holds active keys --- */}
      {target && target.keys > 0 ? (
        <Modal
          open={dialog === 'delete'}
          title={`Delete ${target.name}?`}
          tone="danger"
          mark={<Icon name="alert" size={16} />}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
              <Button variant="danger" onClick={remove} loading={busy}>
                Delete anyway
              </Button>
            </>
          }
        >
          <Alert tone="warn" title="This agent still has active credentials">
            This agent has {target.keys} active API key(s). Deleting the agent deletes them too — they leave the key list rather than staying on it revoked.
          </Alert>
        </Modal>
      ) : (
        <ConfirmModal
          open={dialog === 'delete'}
          title={`Delete ${target ? target.name : 'this agent'}?`}
          description="This can't be undone. The agent's keys are deleted with it; its audit history is retained."
          confirmLabel="Delete agent"
          onClose={() => setDialog(null)}
          onConfirm={remove}
        />
      )}

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}
