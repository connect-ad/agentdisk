import React, { useState } from 'react';
import {
  PageHead, Panel, DataTable, Button, IconButton, Icon, Input, Select, Badge,
  Checkbox, Modal, ConfirmModal, EmptyState, ApiKeyDisplay, Alert, Toast
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import StatePill from '../components-local/StatePill.jsx';
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

/** Mirrors the API: keys.ts NAME_MAX and PREFIX_MAX_DEPTH. */
const NAME_MAX = 15;
const PREFIX_MAX_DEPTH = 2;

/** How many levels a typed restriction has, ignoring a trailing `/` or `/*`. */
function prefixDepth(raw) {
  return raw.trim().replace(/\*$/, '').split('/').filter(Boolean).length;
}

/**
 * The State column: one pill, tone plus word plus mark, and the "why" as
 * its hover text where there is one. A green dot for a working key; the
 * caution triangle for a disabled one, whichever switch turned it off.
 */
function keyStateView(r) {
  if (r.status === 'revoked') return { icon: 'lock', tone: 'danger', label: 'Revoked', title: 'Revoked by support' };
  if (r.status === 'expired') return { icon: 'clock', tone: 'warn', label: 'Expired', title: 'Expired' };
  if (r.status === 'disabled') {
    return r.disabledBy === 'agent'
      ? { icon: 'alert', tone: 'warn', label: 'Disabled', title: 'Disabled, its agent is off' }
      : { icon: 'alert', tone: 'warn', label: 'Disabled', title: 'Disabled' };
  }
  return { icon: 'dot', tone: 'ok', label: 'Active', title: 'Active' };
}

export default function ApiKeys() {
  const { api, workspaceId, canWrite, role } = useWorkspace();
  const { status, data, error, reload } = useResource(loadKeys);

  const [dialog, setDialog] = useState(null); // 'create' | 'reveal' | 'rotated' | 'view' | 'enable' | 'disable' | 'delete'
  const [target, setTarget] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [pathPrefix, setPathPrefix] = useState('');
  const [expiry, setExpiry] = useState('never');
  const [ops, setOps] = useState({ read: true, write: false, delete: false, list: true });
  // The one secret on screen at a time: a freshly minted key, a rotated one,
  // or the one the owner asked to view. Cleared when its dialog closes.
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
    if (name.trim().length > NAME_MAX) { setFormError(`Use at most ${NAME_MAX} characters for the name.`); return; }
    if (chosen.length === 0) { setFormError('A key with no permissions could not do anything.'); return; }
    if (prefixDepth(pathPrefix) > PREFIX_MAX_DEPTH) {
      setFormError(`Restrict to at most ${PREFIX_MAX_DEPTH} levels, like /abc/dev.`);
      return;
    }

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

  /**
   * The eye opens a dialog rather than unmasking in place. A 40-character
   * secret does not fit in a compact row, and a value that lives in a dialog
   * is gone the moment the dialog is, rather than left on screen behind
   * whatever the person does next.
   */
  const view = async r => {
    try {
      const { secret: value } = await api.revealKey(workspaceId, r.id);
      setSecret(value);
      setTarget(r);
      setDialog('view');
    } catch (err) {
      setToast(`Could not show the key: ${err.message}`);
    }
  };

  const columns = [
    // Sized, so the slack goes to the key column rather than trailing the name.
    { key: 'name', header: 'Name', primary: true, width: 200 },
    {
      key: 'agent',
      header: 'Agent',
      width: 150,
      render: r =>
        r.agentId
          ? <Badge tone="accent" mono>{agentName(r.agentId) ?? r.agentId}</Badge>
          : <span style={{ color: 'var(--ink-2)' }}>Workspace</span>
    },
    {
      key: 'key',
      header: 'Key',
      // The eye. Owner only, because a reader who can read a write-scoped key
      // can write; disabled for a key minted before keys were kept, because
      // nothing brings that one back; absent on a revoked key, which the API
      // refuses anyway. The masked key and the eye share one line - the
      // secret itself never appears here, only in the dialog the eye opens.
      render: r => (
        <span className="ds__kkey" onClick={e => e.stopPropagation()}>
          <span className="ad-mono ds__kmask">{r.prefix}{'•'.repeat(8)}{r.lastFour}</span>
          {role === 'owner' && r.status !== 'revoked' ? (
            <IconButton
              icon={<Icon name="eye" size={14} />}
              label={r.retrievable ? `Show ${r.name}` : 'Created before keys were kept. Mint a new one to have one you can view.'}
              disabled={!r.retrievable}
              onClick={() => view(r)}
            />
          ) : null}
        </span>
      )
    },
    {
      key: 'scope',
      header: 'Scope',
      width: 150,
      // Two lines: what it may do, then where. One line ran to the width of
      // three columns once a path was involved.
      render: r => (
        <span className="ds__kscope ad-mono">
          <span>{(r.scopes?.ops ?? []).join(', ') || '\u2014'}</span>
          <span>{r.scopes?.pathPrefix ? `${r.scopes.pathPrefix}/*` : '/*'}</span>
        </span>
      )
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      width: 110,
      render: r => <span style={{ color: 'var(--ink-2)' }}>{relativeTime(r.lastUsedAt)}</span>
    },
    {
      key: 'state',
      header: 'State',
      width: 130,
      // The pill is the menu. Every item still opens a confirmation before
      // anything happens to the credential - Enable included, because
      // enabling rotates the secret. A key that is off because its agent is
      // off gets no Enable: its own switch is already on, so pressing it
      // would appear to work and change nothing; the hover text points at
      // the agent instead. A reader gets the pill with no menu at all.
      render: r => {
        const v = keyStateView(r);
        const off = r.status === 'revoked' || r.status === 'expired' || r.disabledBy === 'agent';
        const items = !canWrite ? [] : [
          ...(off ? [] : r.status === 'disabled'
            ? [{ label: 'Enable', icon: 'refresh', disabled: busy, onSelect: () => { setTarget(r); setDialog('enable'); } }]
            : [{ label: 'Disable', icon: 'x', disabled: busy, onSelect: () => { setTarget(r); setDialog('disable'); } }]),
          { label: 'Delete', icon: 'trash', danger: true, disabled: busy, onSelect: () => { setTarget(r); setDialog('delete'); } }
        ];
        return (
          <span onClick={e => e.stopPropagation()}>
            <StatePill tone={v.tone} icon={v.icon} label={v.label} title={v.title} items={items} />
          </span>
        );
      }
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
          className="ds__ktbl"
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
          placeholder="research-bot"
          maxLength={NAME_MAX}
          hint={`Up to ${NAME_MAX} characters.`}
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
          hint="Up to two levels, like /abc/dev. Leave empty for full workspace access."
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
        className="ds__kview"
        title="Your API key"
        tone="accent"
        size="lg"
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

      {/* --- the eye: one key, in a dialog, gone when it closes --- */}
      <Modal
        open={dialog === 'view'}
        className="ds__kview"
        title={target ? target.name : 'API key'}
        tone="accent"
        size="lg"
        mark={<Icon name="key" size={18} />}
        onClose={() => { setSecret(''); setDialog(null); }}
        footer={
          <>
            {/* True, and worth saying here: the API writes key.revealed on
                every success, so the owner learns the log exists at the one
                moment it concerns them. */}
            <span className="ds__kcap">Reveal logged to activity</span>
            <Button onClick={() => { setSecret(''); setDialog(null); }}>Done</Button>
          </>
        }
      >
        <ApiKeyDisplay revealed secret={secret} />
      </Modal>

      {/*
        Enabling is not "back as it was": the secret changes. Confirmed for
        that reason, and because the control is now an icon a hand can brush.
      */}
      <ConfirmModal
        open={dialog === 'enable'}
        destructive={false}
        title={`Enable ${target ? target.name : 'this key'}?`}
        description="Enabling issues a new key. Whatever was using the old one will need updating before it works again."
        confirmLabel="Enable key"
        onClose={() => setDialog(null)}
        onConfirm={() => { const t = target; setDialog(null); return setStatus(t, 'active'); }}
      />

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
        className="ds__kview"
        title="Your new API key"
        tone="accent"
        size="lg"
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
