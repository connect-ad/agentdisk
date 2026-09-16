import React, { useState } from 'react';
import {
  PageHead, Panel, DataTable, Button, Icon, Input, Select, Badge,
  Checkbox, Modal, ConfirmModal, EmptyState, ApiKeyDisplay, Alert, Toast
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.16 API Keys (workspace-level) — MVP-0, incl. 8.17 Create API Key.
 * URL: /w/{ws}/keys
 *
 * The reveal-once state is the security-critical one, and it is the reason this
 * screen holds the secret in component state rather than refetching it: the API
 * returns the raw key in the creation response and nowhere else, ever. The modal
 * has no close button and no scrim dismiss, so it cannot be lost to a stray
 * click — acknowledging it is the only way out, and that acknowledgment is the
 * moment the value stops existing outside the user's clipboard.
 */

const loadKeys = async (api, workspaceId) => {
  // Agents are needed for the create form's picker, so both come together
  // rather than making the modal fetch on open and stutter.
  const [keys, agents] = await Promise.all([
    api.listKeys(workspaceId),
    api.listAgents(workspaceId).catch(() => ({ agents: [] }))
  ]);
  return { keys: keys.keys ?? [], agents: agents.agents ?? [] };
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

const EXPIRY_DAYS = { never: null, 30: 30, 90: 90 };

export default function ApiKeys() {
  const { api, workspaceId, canWrite } = useWorkspace();
  const { status, data, error, reload } = useResource(loadKeys);

  const [dialog, setDialog] = useState(null); // 'create' | 'reveal' | 'revoke'
  const [target, setTarget] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [expiry, setExpiry] = useState('never');
  const [ops, setOps] = useState({ read: true, write: false, delete: false, list: true });
  const [secret, setSecret] = useState('');

  const keys = data?.keys ?? [];
  const agents = data?.agents ?? [];
  const loading = status === 'loading';

  const resetForm = () => {
    setName(''); setAgentId(''); setPathPrefix(''); setExpiry('never');
    setOps({ read: true, write: false, delete: false, list: true });
    setFormError(null);
  };

  const create = async () => {
    const chosen = Object.entries(ops).filter(([, on]) => on).map(([op]) => op);
    if (!name.trim()) { setFormError('Give the key a name so you can recognise it later.'); return; }
    if (chosen.length === 0) { setFormError('A key with no permissions could not do anything.'); return; }

    setBusy(true); setFormError(null);
    try {
      const days = EXPIRY_DAYS[expiry];
      const result = await api.createKey(workspaceId, {
        name: name.trim(),
        ops: chosen,
        ...(agentId ? { agentId } : {}),
        ...(pathPrefix.trim() ? { pathPrefix: pathPrefix.trim() } : {}),
        ...(days ? { expiresAt: Date.now() + days * 86400000 } : {})
      });
      setSecret(result.secret);
      setDialog('reveal');
      void reload();
    } catch (err) {
      setFormError(`${err.message}${err.requestId ? ` (request ${err.requestId})` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.revokeKey(workspaceId, target.id);
      setToast('Key revoked');
      void reload();
    } catch (err) {
      setToast(`Could not revoke: ${err.message}`);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const agentName = id => agents.find(a => a.id === id)?.name ?? null;

  const columns = [
    { key: 'name', header: 'Name', primary: true },
    {
      key: 'agent',
      header: 'Agent',
      width: 190,
      render: r =>
        r.agentId
          ? <Badge tone="accent" mono>{agentName(r.agentId) ?? r.agentId}</Badge>
          : <span style={{ color: 'var(--ink-3)' }}>Workspace</span>
    },
    { key: 'key', header: 'Key', width: 200, render: r => <ApiKeyDisplay lastFour={r.lastFour} /> },
    {
      key: 'scope',
      header: 'Scope',
      width: 260,
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
      key: 'status',
      header: 'Status',
      width: 120,
      render: r =>
        r.status === 'revoked' ? <Badge tone="danger" dot>Revoked</Badge>
          : r.status === 'expired' ? <Badge tone="warn" dot>Expired</Badge>
            // Blocked is the agent's doing, not the key's: the row is intact and
            // re-enabling the agent brings it straight back. Shown as warn
            // rather than danger so it does not read as revoked, which is final.
            : r.status === 'blocked' ? <Badge tone="warn" dot>Agent disabled</Badge>
              : <Badge tone="ok" dot>Active</Badge>
    },
    {
      key: 'act',
      header: 'Actions',
      width: 210,
      // Revoking is irreversible and there is no un-revoke, so the control that
      // does it must not be discoverable only by hovering an unlabelled icon.
      // It was one; the word is the whole point.
      render: r => (
        <span onClick={e => e.stopPropagation()}>
          <Button
            size="sm"
            variant="danger-outline"
            // A blocked key is still revocable. It reported as "active" before
            // `blocked` existed, so testing for `active` here would quietly take
            // away the ability to permanently kill a key whose agent happens to
            // be off — the moment you most want it gone.
            disabled={!canWrite || r.status === 'revoked' || r.status === 'expired'}
            onClick={() => { setTarget(r); setDialog('revoke'); }}
          >
            Revoke
          </Button>
          {/*
            Revocation is a one-way kill switch, matching every other product
            that issues credentials, and that is a deliberate design rather than
            a missing feature. A disabled button with no explanation reads as the
            second one — so the reason sits next to it, where somebody hunting
            for a reactivate control will actually find it.
          */}
          {r.status === 'revoked' ? (
            <span className="ad-meta" style={{ display: 'block', marginTop: 'var(--s-2)' }}>
              Revoked keys can&apos;t be reactivated — mint a new key when you need one.
            </span>
          ) : null}
        </span>
      )
    }
  ];

  return (
    <>
      <PageHead
        title="API keys"
        subtitle="Credentials agents present to reach this workspace. Each key carries its own scope."
        actions={
          canWrite ? (
            <Button
              icon={<Icon name="plus" size={14} />}
              onClick={() => { resetForm(); setDialog('create'); }}
            >
              Create key
            </Button>
          ) : null
        }
      />

      {status === 'failed' ? (
        <Alert tone="danger" title="Could not load keys" actions={<Button size="sm" onClick={reload}>Try again</Button>}>
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      ) : null}

      <Panel flush title="Keys">
        <DataTable
          columns={columns}
          rows={loading ? [] : keys}
          loading={loading}
          skeletonRows={3}
          empty={
            <EmptyState
              icon={<Icon name="key" size={19} />}
              title="No API keys yet"
              actions={canWrite ? <Button size="sm" onClick={() => { resetForm(); setDialog('create'); }}>Create your first key</Button> : null}
            >
              A key is what lets an agent authenticate. Without one, an agent is inert.
            </EmptyState>
          }
        />
      </Panel>

      {/* --- 8.17 Create API key --- */}
      <Modal
        open={dialog === 'create'}
        title="Create API key"
        tone="accent"
        size="md"
        mark={<Icon name="key" size={16} />}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={create} loading={busy}>Create key</Button>
          </>
        }
      >
        {formError ? <div role="alert"><Alert tone="danger" title={formError} /></div> : null}
        <Input
          label="Name"
          required
          placeholder="prod-research-bot"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <Select
          label="Agent"
          optional
          value={agentId}
          onChange={e => setAgentId(e.target.value)}
          hint="Optional. A workspace-level key works on its own — choose an agent only to attribute its activity and revoke its keys as a group."
          options={[
            { value: '', label: 'No agent (workspace-level)' },
            ...agents.filter(a => a.status === 'active').map(a => ({ value: a.id, label: a.name }))
          ]}
        />
        <div>
          <p className="ad-label" style={{ marginBottom: 'var(--s-4)' }}>Permissions</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <Checkbox label="Read" description="Download files." checked={ops.read} onChange={() => setOps(o => ({ ...o, read: !o.read }))} />
            <Checkbox label="List" description="Enumerate folder contents." checked={ops.list} onChange={() => setOps(o => ({ ...o, list: !o.list }))} />
            <Checkbox label="Write" description="Upload and overwrite files." checked={ops.write} onChange={() => setOps(o => ({ ...o, write: !o.write }))} />
            <Checkbox label="Delete" description="Permanently remove files. Grant sparingly." checked={ops.delete} onChange={() => setOps(o => ({ ...o, delete: !o.delete }))} />
          </div>
        </div>
        <Input
          label="Restrict to path"
          optional
          mono
          placeholder="/projects/demo"
          hint="Leave empty for full workspace access."
          value={pathPrefix}
          onChange={e => setPathPrefix(e.target.value)}
        />
        <Select
          label="Expires"
          value={expiry}
          onChange={e => setExpiry(e.target.value)}
          options={[
            { value: 'never', label: 'Never' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' }
          ]}
        />
      </Modal>

      {/* --- reveal-once: no onClose, so it cannot be dismissed by accident --- */}
      <Modal
        open={dialog === 'reveal'}
        title="Your API key"
        tone="accent"
        size="md"
        mark={<Icon name="key" size={16} />}
        footer={
          <Button
            onClick={() => {
              // Dropping it from state here is the point: after this click the
              // value genuinely does not exist anywhere in the app.
              setSecret('');
              setDialog(null);
              setToast('Key created');
            }}
          >
            I&rsquo;ve copied my key
          </Button>
        }
      >
        <Alert tone="warn" title="Copy this now — you won't be able to see it again">
          We store only a hash of this key. If you lose it, revoke it and create a new one.
        </Alert>
        <ApiKeyDisplay revealed secret={secret} />
      </Modal>

      <ConfirmModal
        open={dialog === 'revoke'}
        title={`Revoke ${target ? target.name : 'this key'}?`}
        /* The permanence is stated before the commitment, not implied after it.
           "This cannot be undone" was already here and was not enough: it reads
           as "you can't un-press this button", when the thing people need to
           know is that the credential itself never comes back. */
        description="Any agent using this key loses access on its very next request. A revoked key can never be reactivated — restoring access means minting a new key and updating whatever was using this one."
        confirmLabel="Revoke key"
        onClose={() => setDialog(null)}
        onConfirm={revoke}
      />

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)}>
            {toast === 'Key revoked' ? 'Any client using it lost access immediately.' : null}
          </Toast>
        </div>
      ) : null}
    </>
  );
}
