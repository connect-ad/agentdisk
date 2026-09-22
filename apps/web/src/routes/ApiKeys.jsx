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
  const { api, workspaceId, canWrite, role } = useWorkspace();
  const { status, data, error, reload } = useResource(loadKeys);

  const [dialog, setDialog] = useState(null); // 'create' | 'reveal' | 'rotated' | 'disable' | 'delete'
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
  // Keys the owner has chosen to show, by id. Fetched on demand, held only
  // while shown: Hide drops it, and a reload starts empty.
  const [shown, setShown] = useState({});
  const [revealError, setRevealError] = useState(null);

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

  /**
   * Off, or on again with a new secret.
   *
   * Enabling rotates, so the new key is shown the same way a freshly minted
   * one is: whatever was using the old token has to be updated, and a toast
   * saying "enabled" would hide the one fact that matters.
   */
  const setStatus = async (r, status) => {
    setBusy(true);
    try {
      const result = await api.setKeyStatus(workspaceId, r.id, status);
      if (result.rotated) {
        setSecret(result.secret);
        setDialog('rotated');
      } else {
        setToast(status === 'disabled' ? 'Key disabled' : 'Key enabled');
      }
      // Whatever was shown is the old value now.
      setShown(s => { const next = { ...s }; delete next[r.id]; return next; });
      void reload();
    } catch (err) {
      setToast(`Could not change the key: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await api.deleteKey(workspaceId, target.id);
      setToast('Key deleted');
      void reload();
    } catch (err) {
      setToast(`Could not delete: ${err.message}`);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const agentName = id => agents.find(a => a.id === id)?.name ?? null;

  const toggleShown = async r => {
    if (shown[r.id]) {
      setShown(s => { const next = { ...s }; delete next[r.id]; return next; });
      return;
    }
    setRevealError(null);
    try {
      const { secret: value } = await api.revealKey(workspaceId, r.id);
      setShown(s => ({ ...s, [r.id]: value }));
    } catch (err) {
      setRevealError({ id: r.id, message: err.message });
    }
  };

  const copyShown = r => {
    try { navigator.clipboard.writeText(shown[r.id]); } catch (e) { /* clipboard unavailable */ }
    setToast('Key copied');
  };

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
    {
      key: 'key',
      header: 'Key',
      width: 320,
      // The eye. Owner only, because a reader who can read a write-scoped key
      // can write; disabled for a key minted before keys were kept, because
      // nothing brings that one back; absent on a revoked key, which the API
      // refuses anyway. Show/Hide is a word beside the icon, not an icon
      // alone - the same rule Revoke follows.
      render: r => (
        <span
          className="row"
          style={{ gap: 'var(--s-3)', alignItems: 'center', flexWrap: 'wrap' }}
          onClick={e => e.stopPropagation()}
        >
          {shown[r.id]
            ? <code className="ad-mono" style={{ userSelect: 'all' }}>{shown[r.id]}</code>
            : <ApiKeyDisplay prefix={r.prefix} lastFour={r.lastFour} />}
          {role === 'owner' && r.status !== 'revoked' ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name={shown[r.id] ? 'eyeOff' : 'eye'} size={13} />}
              disabled={!r.retrievable}
              title={r.retrievable ? undefined : 'Created before keys were kept. Mint a new one to have one you can view.'}
              onClick={() => toggleShown(r)}
            >
              {shown[r.id] ? 'Hide' : 'Show'}
            </Button>
          ) : null}
          {shown[r.id] ? (
            <Button size="sm" variant="secondary" icon={<Icon name="copy" size={13} />} onClick={() => copyShown(r)}>
              Copy
            </Button>
          ) : null}
          {revealError?.id === r.id ? (
            <span className="ad-meta" role="alert">{revealError.message}</span>
          ) : null}
        </span>
      )
    },
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
      // One word for "it does not work", however it came to be off, because
      // that is the question being asked of this column. Why, and what to do
      // about it, is the Actions column's job.
      render: r =>
        r.status === 'revoked' ? <Badge tone="danger" dot>Revoked</Badge>
          : r.status === 'expired' ? <Badge tone="warn" dot>Expired</Badge>
            : r.status === 'disabled' ? <Badge tone="warn" dot>Disabled</Badge>
              : <Badge tone="ok" dot>Active</Badge>
    },
    {
      key: 'act',
      header: 'Actions',
      width: 260,
      // Words, not bare icons: every one of these either stops a live
      // credential, changes it, or destroys it.
      render: r => (
        <span
          className="row"
          style={{ gap: 'var(--s-3)', alignItems: 'center', flexWrap: 'wrap' }}
          onClick={e => e.stopPropagation()}
        >
          {/*
            The agent case has no Enable button on purpose. The key's own
            switch is already on — enabling it here would appear to work and
            change nothing, because the refusal is the agent's. The sentence
            points at the control that would actually help.
          */}
          {r.disabledBy === 'agent' ? (
            <span className="ad-meta">Its agent is disabled.</span>
          ) : r.status === 'revoked' ? (
            <span className="ad-meta">Revoked by support.</span>
          ) : r.status === 'expired' ? (
            <span className="ad-meta">Expired.</span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={!canWrite || busy}
              onClick={() => (r.status === 'disabled'
                ? setStatus(r, 'active')
                : (setTarget(r), setDialog('disable')))}
            >
              {r.status === 'disabled' ? 'Enable' : 'Disable'}
            </Button>
          )}
          <Button
            size="sm"
            variant="danger-outline"
            disabled={!canWrite || busy}
            onClick={() => { setTarget(r); setDialog('delete'); }}
          >
            Delete
          </Button>
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
        onSubmit={create}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button type="submit" loading={busy}>Create key</Button>
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
          hint="Optional. A workspace-level key works on its own — choose an agent only to attribute its activity and disable its keys as a group."
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

      {/* --- the new key: no onClose, so it cannot be dismissed by accident --- */}
      <Modal
        open={dialog === 'reveal'}
        title="Your API key"
        tone="accent"
        size="md"
        mark={<Icon name="key" size={16} />}
        footer={
          <Button
            onClick={() => {
              // Out of this screen's state; the table's eye button fetches it
              // afresh, so nothing here holds a secret longer than it is shown.
              setSecret('');
              setDialog(null);
              setToast('Key created');
            }}
          >
            Done
          </Button>
        }
      >
        {/*
          This used to warn "you won't be able to see it again — we store only
          a hash". Keys are kept now (sealed; migration 0022), and the owner
          can view one from the table at any time, so the warning would be
          false and the urgency it created has nothing behind it.
        */}
        <p className="ad-small ad-measure">
          Copy it into your agent now. As the workspace owner you can view it again any
          time from the eye button in the keys table.
        </p>
        <ApiKeyDisplay revealed secret={secret} />
      </Modal>

      {/*
        Disabling is reversible and still worth confirming: it stops a live
        credential at once. What it must not imply is that enabling puts things
        back as they were — the secret changes, and that is the sentence people
        need before they press it, not after.
      */}
      <ConfirmModal
        open={dialog === 'disable'}
        title={`Disable ${target ? target.name : 'this key'}?`}
        description="Any agent using this key loses access on its very next request. You can enable it again, but enabling issues a new key — whatever was using this one will need updating."
        confirmLabel="Disable key"
        onClose={() => setDialog(null)}
        onConfirm={() => { const t = target; setDialog(null); return setStatus(t, 'disabled'); }}
      />

      <ConfirmModal
        open={dialog === 'delete'}
        title={`Delete ${target ? target.name : 'this key'}?`}
        description="The key is removed and any agent using it loses access on its very next request. This cannot be undone — if you only want to stop it for now, disable it instead."
        confirmLabel="Delete key"
        onClose={() => setDialog(null)}
        onConfirm={destroy}
      />

      {/* The rotation, shown the way a new key is - because it is one. */}
      <Modal
        open={dialog === 'rotated'}
        title="Your new API key"
        tone="accent"
        size="md"
        mark={<Icon name="key" size={16} />}
        footer={
          <Button onClick={() => { setSecret(''); setDialog(null); setToast('Key enabled'); }}>
            Done
          </Button>
        }
      >
        <Alert tone="warn" title="The old key no longer works">
          Enabling issues a new secret. Update whatever was using this key, or it will keep
          being refused.
        </Alert>
        <ApiKeyDisplay revealed secret={secret} />
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)}>
            {toast === 'Key disabled' || toast === 'Key deleted'
              ? 'Any client using it lost access immediately.'
              : null}
          </Toast>
        </div>
      ) : null}
    </>
  );
}
