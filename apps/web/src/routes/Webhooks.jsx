import React, { useState } from 'react';
import {
  PageHead, Panel, DataTable, Button, IconButton, Icon, Input, Badge, Checkbox,
  Modal, ConfirmModal, EmptyState, ApiKeyDisplay, Alert, Toast, CodeBlock
} from '../components/index.js';
import { useResource } from '../lib/useResource.js';
import { useWorkspace } from '../lib/workspace.jsx';

/**
 * 8.18a Webhooks — MVP-1
 * URL: /w/{ws}/webhooks
 *
 * The signing-secret reveal deliberately reuses 8.16's reveal-once pattern
 * (ApiKeyDisplay + explicit acknowledgment, no dismiss-by-accident) rather than
 * reinventing it.
 *
 * Failure detail never renders request/response headers — those can carry
 * secrets (doc 06 PART 16.18). Status code + truncated body only.
 */



const FAILURES = `503 Service Unavailable
upstream connect error or disconnect/reset before headers

502 Bad Gateway
<html><head><title>502 Bad Gateway</title></head><body>…

503 Service Unavailable
upstream connect error or disconnect/reset before headers`;


const loadWebhooks = (api, workspaceId) => api.listWebhooks(workspaceId);

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

export default function Webhooks() {
  const { api, workspaceId, canWrite } = useWorkspace();
  const { status, data, error, reload } = useResource(loadWebhooks);

  const [dialog, setDialog] = useState(null); // 'create' | 'reveal' | 'delete'
  const [target, setTarget] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [toast, setToast] = useState(null);
  const [picked, setPicked] = useState({ 'file.created': true });
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const loading = status === 'loading';
  // The event list comes from the API rather than a constant here, so a new
  // event type does not need a frontend deploy to become subscribable.
  const availableEvents = data?.availableEvents ?? [];
  const deliveryEnabled = data?.deliveryEnabled ?? false;

  const rows = (data?.webhooks ?? []).map(w => ({
    ...w,
    ok: w.status === 'active',
    last: relativeTime(w.lastDeliveryAt)
  }));

  const create = async () => {
    const events = Object.entries(picked).filter(([, on]) => on).map(([name]) => name);
    if (!url.trim()) { setFormError('Enter the URL to deliver to.'); return; }
    if (events.length === 0) { setFormError('Subscribe to at least one event.'); return; }

    setBusy(true); setFormError(null);
    try {
      const result = await api.createWebhook(workspaceId, { url: url.trim(), events });
      setSecret(result.secret);
      setDialog('reveal');
      setUrl('');
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
      await api.deleteWebhook(workspaceId, target.id);
      setToast('Endpoint deleted');
      void reload();
    } catch (err) {
      setToast(`Could not delete: ${err.message}`);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  const togglePaused = async row => {
    try {
      await api.updateWebhook(workspaceId, row.id, { status: row.ok ? 'paused' : 'active' });
      void reload();
    } catch (err) {
      setToast(`Could not update: ${err.message}`);
    }
  };

  const columns = [
    { key: 'url', header: 'Endpoint', primary: true, render: r => <span className="ad-mono-sm">{r.url}</span> },
    {
      key: 'events',
      header: 'Events',
      width: 280,
      render: r => (
        <span style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          {r.events.map(e => <Badge key={e} mono>{e}</Badge>)}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      width: 150,
      render: r => r.ok
        ? <Badge tone="ok" dot>Active</Badge>
        : <Badge tone="danger" dot>Failing</Badge>
    },
    { key: 'last', header: 'Last delivery', width: 160, render: r => <span style={{ color: 'var(--ink-3)' }}>{r.last}</span> },
    {
      key: 'act',
      header: '',
      width: 84,
      render: r => (
        <span onClick={e => e.stopPropagation()} className="row" style={{ gap: 0 }}>
          <IconButton
            icon={<Icon name={r.ok ? 'pause' : 'bolt'} size={14} />}
            label={`${r.ok ? 'Pause' : 'Resume'} ${r.url}`}
            disabled={!canWrite}
            onClick={() => togglePaused(r)}
          />
          <IconButton tone="danger" icon={<Icon name="trash" size={14} />} label={`Delete ${r.url}`} disabled={!canWrite} onClick={() => { setTarget(r); setDialog('delete'); }} />
        </span>
      )
    }
  ];

  return (
    <>
      <PageHead
        title="Webhooks"
        subtitle="Outbound notifications when objects in this workspace change."
        actions={canWrite ? <Button icon={<Icon name="plus" size={14} />} onClick={() => { setFormError(null); setDialog('create'); }}>Add endpoint</Button> : null}
      />

      {status === 'failed' ? (
        <Alert tone="danger" title="Could not load webhooks" actions={<Button size="sm" onClick={reload}>Try again</Button>}>
          {error?.message}{error?.requestId ? ` (request ${error.requestId})` : ''}
        </Alert>
      ) : null}

      {!loading && !deliveryEnabled ? (
        <Alert tone="warn" title="Deliveries are not running">
          Endpoints registered here are stored, but nothing is being sent to them.
        </Alert>
      ) : null}

      <Panel flush title="Endpoints">
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={<Icon name="link" size={19} />}
              title="No webhooks yet"
              actions={<Button size="sm" onClick={() => setDialog('create')}>Add endpoint</Button>}
            >
              Get notified when files change — useful for triggering downstream automation.
            </EmptyState>
          }
          onRowClick={r => (r.ok ? undefined : setExpanded(expanded === r.id ? null : r.id))}
        />
      </Panel>

      {/* Inline failure expansion for a failing endpoint. */}
      {rows.filter(r => !r.ok).map(r => (
        <Panel
          key={r.id}
          title={`Failing — last ${r.failures} deliveries didn't succeed`}
          subtitle={r.url}
          actions={
            <>
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={expanded === r.id}
                onClick={() => setExpanded(expanded === r.id ? null : r.id)}
              >
                {expanded === r.id ? 'Hide recent failures' : 'View recent failures'}
              </Button>
              {/* Rotation needs an endpoint that does not exist yet. Offering
                  the button would promise something the product cannot do; the
                  honest path today is delete and re-add. */}
              <Button size="sm" variant="danger-outline" onClick={() => { setTarget(r); setDialog('delete'); }}>
                Delete endpoint
              </Button>
            </>
          }
        >
          {expanded === r.id ? (
            <>
              <Alert tone="warn" title="Deliveries are retried with backoff, then dead-lettered">
                Response bodies are truncated and headers are never shown — they can carry secrets.
              </Alert>
              <CodeBlock filename="Recent delivery failures" code={FAILURES} copyable={false} />
            </>
          ) : null}
        </Panel>
      ))}

      {/* --- create --- */}
      <Modal
        open={dialog === 'create'}
        title="Add webhook endpoint"
        tone="accent"
        size="md"
        mark={<Icon name="link" size={16} />}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={create} loading={busy}>Add endpoint</Button>
          </>
        }
      >
        {formError ? <div role="alert"><Alert tone="danger" title={formError} /></div> : null}
        <Input
          label="URL"
          required
          mono
          type="url"
          placeholder="https://your-service.com/webhooks/agentdisk"
          hint="HTTPS only. The API refuses anything else — plaintext delivery would put file paths on the wire."
          value={url}
          onChange={e => setUrl(e.target.value)}
        />
        <div>
          <p className="ad-label" style={{ marginBottom: 'var(--s-4)' }}>Events</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            {availableEvents.map(e => (
              <Checkbox
                key={e}
                label={e}
                checked={!!picked[e]}
                onChange={() => setPicked(p => ({ ...p, [e]: !p[e] }))}
              />
            ))}
          </div>
        </div>
      </Modal>

      {/* --- reveal-once signing secret: same pattern as 8.16 --- */}
      <Modal
        open={dialog === 'reveal'}
        title="Your signing secret"
        tone="accent"
        size="md"
        mark={<Icon name="lock" size={16} />}
        footer={
          <Button
            onClick={() => {
              // Dropped here, so after this click the value exists nowhere in
              // the app - the honest version of what the copy promises.
              setSecret('');
              setDialog(null);
              setToast('Webhook endpoint added');
            }}
          >
            I&rsquo;ve copied my secret
          </Button>
        }
      >
        <Alert tone="warn" title="Copy this now — you won't be able to see it again">
          Use it to verify that deliveries actually came from AgentDisk.
        </Alert>
        <ApiKeyDisplay revealed secret={secret} />
      </Modal>

      <ConfirmModal
        open={dialog === 'delete'}
        title="Delete this webhook endpoint?"
        description={`AgentDisk will stop sending events to ${target ? target.url : 'this endpoint'}.`}
        confirmLabel="Delete"
        onClose={() => setDialog(null)}
        onConfirm={remove}
      />

      {toast ? (
        <div style={{ position: 'fixed', top: 'var(--s-7)', right: 'var(--s-7)', zIndex: 90 }}>
          <Toast tone="ok" title={toast} onDismiss={() => setToast(null)} />
        </div>
      ) : null}
    </>
  );
}
